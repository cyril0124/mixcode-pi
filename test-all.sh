#!/usr/bin/env bash
set -euo pipefail

# Parallel gate: typecheck, build, lint, package tests (not full test/*.test.ts).
# --no-exit-on-error lets every job finish so one red job does not hide others;
# the exit code is still the first failing job's.
exec bun run --parallel --no-exit-on-error typecheck build lint test:packages
