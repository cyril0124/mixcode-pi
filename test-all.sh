#!/usr/bin/env bash
set -euo pipefail

# Parallel gate: typecheck, build, lint, package tests (not full test/*.test.ts).
# Collect failures so one red job does not hide others.
fail=0
pids=()

run_job() {
  local name="$1"
  shift
  (
    if "$@"; then
      printf '[ok] %s\n' "$name"
    else
      printf '[fail] %s\n' "$name" >&2
      exit 1
    fi
  ) &
  pids+=("$!")
}

run_job typecheck bun run typecheck
run_job build bun run build
run_job lint bun run lint
run_job test:packages bun run test:packages

for pid in "${pids[@]}"; do
  if ! wait "$pid"; then
    fail=1
  fi
done

exit "$fail"
