#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
export LC_ALL=C

usage() {
  echo "usage: $0 [--through DIGITS|--only DIGITS|--range DIGITS DIGITS]" >&2
}

mode="all"
target_version=""
range_start=""
range_end=""
if (( $# > 0 )); then
  case "$1" in
    --through)
      if (( $# != 2 )); then usage; exit 2; fi
      mode="through"
      target_version="$2"
      ;;
    --only)
      if (( $# != 2 )); then usage; exit 2; fi
      mode="only"
      target_version="$2"
      ;;
    --range)
      if (( $# != 3 )); then usage; exit 2; fi
      mode="range"
      range_start="$2"
      range_end="$3"
      ;;
    *)
      usage
      exit 2
      ;;
  esac
  if [[ "$mode" == "range" ]]; then
    if [[ ! "$range_start" =~ ^[0-9]{4,}$ ]] \
      || [[ ! "$range_end" =~ ^[0-9]{4,}$ ]] \
      || [[ "$range_start" > "$range_end" ]]; then
      echo "migration range must be ordered numeric versions of at least four digits" >&2
      exit 2
    fi
  elif [[ ! "$target_version" =~ ^[0-9]{4,}$ ]]; then
    echo "migration version must be at least four digits: $target_version" >&2
    exit 2
  fi
fi

project_id="$(
  sed -n 's/^project_id = "\(.*\)"$/\1/p' supabase/config.toml | head -n 1
)"
if [[ -z "$project_id" ]]; then
  echo "supabase project_id is missing" >&2
  exit 1
fi

db_container="supabase_db_${project_id}"
if ! docker inspect "$db_container" >/dev/null 2>&1; then
  echo "local Supabase database container is not running: $db_container" >&2
  exit 1
fi

db_name="${QA_DB_NAME:-postgres}"
db_user="${QA_DB_USER:-postgres}"
if [[ ! "$db_name" =~ ^[A-Za-z0-9_]+$ ]] \
  || [[ ! "$db_user" =~ ^[A-Za-z0-9_]+$ ]]; then
  echo "QA_DB_NAME/QA_DB_USER must be simple PostgreSQL identifiers" >&2
  exit 2
fi

shopt -s nullglob
migration_files=(supabase/migrations/*.sql)
if (( ${#migration_files[@]} == 0 )); then
  echo "no migration files found (expected supabase/migrations/*.sql)" >&2
  exit 1
fi

selected_count=0
target_count=0
range_start_count=0
range_end_count=0
seen_migration_versions=" "
ordered_migration_files=()
ordered_migration_versions=()
for migration_file in "${migration_files[@]}"; do
  migration_name="$(basename "$migration_file")"
  if [[ ! "$migration_name" =~ ^([0-9]{4,})_[A-Za-z0-9][A-Za-z0-9._-]*\.sql$ ]]; then
    echo "migration filename must be <unique-digits>_<name>.sql: $migration_name" >&2
    exit 1
  fi
  migration_version="${BASH_REMATCH[1]}"
  if [[ "$seen_migration_versions" == *" $migration_version "* ]]; then
    echo "duplicate migration version $migration_version: $migration_name" >&2
    exit 1
  fi
  seen_migration_versions+="$migration_version "

  insert_at="${#ordered_migration_versions[@]}"
  for (( index = 0; index < ${#ordered_migration_versions[@]}; index += 1 )); do
    if [[ "$migration_version" < "${ordered_migration_versions[$index]}" ]]; then
      insert_at="$index"
      break
    fi
  done
  if (( insert_at == ${#ordered_migration_versions[@]} )); then
    ordered_migration_files+=("$migration_file")
    ordered_migration_versions+=("$migration_version")
  else
    ordered_migration_files=(
      "${ordered_migration_files[@]:0:$insert_at}"
      "$migration_file"
      "${ordered_migration_files[@]:$insert_at}"
    )
    ordered_migration_versions=(
      "${ordered_migration_versions[@]:0:$insert_at}"
      "$migration_version"
      "${ordered_migration_versions[@]:$insert_at}"
    )
  fi
done

for migration_index in "${!ordered_migration_files[@]}"; do
  migration_file="${ordered_migration_files[$migration_index]}"
  migration_version="${ordered_migration_versions[$migration_index]}"
  migration_name="$(basename "$migration_file")"

  if [[ "$migration_version" == "$target_version" ]]; then
    target_count=$((target_count + 1))
  fi
  if [[ "$migration_version" == "$range_start" ]]; then
    range_start_count=$((range_start_count + 1))
  fi
  if [[ "$migration_version" == "$range_end" ]]; then
    range_end_count=$((range_end_count + 1))
  fi
  if [[ "$mode" == "through" && "$migration_version" > "$target_version" ]]; then
    continue
  fi
  if [[ "$mode" == "only" && "$migration_version" != "$target_version" ]]; then
    continue
  fi
  if [[ "$mode" == "range" ]] \
    && { [[ "$migration_version" < "$range_start" ]] \
      || [[ "$migration_version" > "$range_end" ]]; }; then
    continue
  fi

  echo "Applying $migration_name to $db_name"
  if [[ "$migration_version" == "0094" ]]; then
    BOSS_PAEGI_LOCAL_OAUTH_CONTRACT_FIXTURE=1 \
      node scripts/qa/render-local-oauth-contract.mjs \
      | docker exec -i "$db_container" \
          psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
  elif [[ "$migration_version" == "0095" ]]; then
    BOSS_PAEGI_LOCAL_ANALYTICS_MAINTENANCE_BOUNDS_FIXTURE=1 \
      node scripts/qa/render-local-analytics-maintenance-bounds.mjs \
      | docker exec -i "$db_container" \
          psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name"
  else
    docker exec -i "$db_container" \
      psql -X -v ON_ERROR_STOP=1 -U "$db_user" -d "$db_name" \
      < "$migration_file"
  fi
  selected_count=$((selected_count + 1))
done

if (( selected_count == 0 )); then
  echo "no migrations selected for mode=$mode target=$target_version" >&2
  exit 1
fi
if [[ "$mode" != "all" && "$target_count" == "0" ]]; then
  if [[ "$mode" != "range" ]]; then
    echo "no migration found with version $target_version" >&2
    exit 1
  fi
fi
if [[ "$mode" == "range" ]] \
  && { (( range_start_count == 0 )) || (( range_end_count == 0 )); }; then
  echo "migration range endpoints are missing: $range_start..$range_end" >&2
  exit 1
fi

scope="${target_version:+ target=$target_version}"
if [[ "$mode" == "range" ]]; then scope=" range=$range_start..$range_end"; fi
echo "Applied $selected_count migration(s) (mode=$mode$scope)"
