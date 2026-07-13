#!/usr/bin/env bash
set -euo pipefail

# Run all checks in parallel: typecheck, build, lint, package tests
npx run-p typecheck build lint test:packages
