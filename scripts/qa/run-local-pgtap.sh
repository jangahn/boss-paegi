#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi

shopt -s nullglob
if (( $# > 1 )) || {
  (( $# == 1 )) \
    && [[ "$1" != "--self-test-empty" ]] \
    && [[ "$1" != "--self-test-notests" ]]
}; then
  echo "usage: $0 [--self-test-empty|--self-test-notests]" >&2
  exit 2
fi
mode="${1:-run}"
if [[ "$mode" == "--self-test-empty" ]]; then
  # CI/unit self-check: a zero-file discovery must be a hard failure, never NOTESTS success.
  test_files=()
elif [[ "$mode" == "--self-test-notests" ]]; then
  # Feed the real result validator a legacy false-green harness result without requiring Docker.
  test_files=("<self-test-notests>")
else
  test_files=(supabase/tests/*.pgtap.sql)
fi
if (( ${#test_files[@]} == 0 )); then
  echo "no pgTAP files found (expected supabase/tests/*.pgtap.sql)" >&2
  exit 1
fi

db_container="supabase_db_${project_id}"
if [[ "$mode" != "--self-test-notests" ]]; then
  if [[ "$db_container" != supabase_db_* ]] \
    || ! docker inspect "$db_container" >/dev/null 2>&1; then
    echo "disposable local Supabase database container is not running: $db_container" >&2
    exit 1
  fi
fi

if [[ "$mode" == "run" ]]; then
  # Manual repository-order migration application intentionally does not run
  # Supabase's test bootstrap. Keep pgTAP out of production migrations while
  # making every disposable fresh DB self-sufficient and non-NOTESTS.
  docker exec -i "$db_container" \
    psql -X -v ON_ERROR_STOP=1 -U postgres -d postgres \
    -c "create schema if not exists extensions; create extension if not exists pgtap with schema extensions;" \
    >/dev/null
fi

failed=0
total_assertions=0
for test_file in "${test_files[@]}"; do
  echo "pgTAP: $test_file"
  if [[ "$mode" == "--self-test-notests" ]]; then
    output=$'Files=0, Tests=0\nResult: NOTESTS'
  else
    if ! output="$(
      docker exec -i "$db_container" \
        psql -X -Aqt -v ON_ERROR_STOP=1 -U postgres -d postgres \
        < "$test_file" 2>&1
    )"; then
      printf '%s\n' "$output"
      echo "pgTAP SQL execution failed: $test_file" >&2
      failed=1
      continue
    fi
  fi

  printf '%s\n' "$output"
  if printf '%s\n' "$output" | grep -Eq '(^Files=0, Tests=0|^Result: NOTESTS$)'; then
    echo "pgTAP runner reported NOTESTS: $test_file" >&2
    failed=1
    continue
  fi
  plan="$(
    printf '%s\n' "$output" \
      | sed -n 's/^1\.\.\([0-9][0-9]*\)$/\1/p' \
      | tail -n 1
  )"
  ran="$(
    printf '%s\n' "$output" \
      | awk '/^(ok|not ok) [0-9]+/ { count += 1 } END { print count + 0 }'
  )"
  if [[ -z "$plan" ]]; then
    echo "pgTAP plan missing: $test_file" >&2
    failed=1
    continue
  fi
  if [[ "$plan" == "0" ]]; then
    echo "pgTAP zero-test plan is forbidden: $test_file" >&2
    failed=1
  fi
  if [[ "$ran" != "$plan" ]]; then
    echo "pgTAP plan mismatch: $test_file planned=$plan ran=$ran" >&2
    failed=1
  fi
  if printf '%s\n' "$output" | grep -Eq '^not ok [0-9]+'; then
    echo "pgTAP assertion failed: $test_file" >&2
    failed=1
  fi
  if printf '%s\n' "$output" | grep -Eq '^# Looks like '; then
    echo "pgTAP harness diagnostic reported failure: $test_file" >&2
    failed=1
  fi
  total_assertions=$((total_assertions + ran))
done

if (( failed != 0 )); then
  exit 1
fi
echo "pgTAP passed: files=${#test_files[@]} assertions=$total_assertions"
