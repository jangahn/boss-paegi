#!/usr/bin/env bash
set -euo pipefail

cd "$(git rev-parse --show-toplevel)"
exec bash scripts/qa/verify-rollout-stage.sh expand
