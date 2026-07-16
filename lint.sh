#!/usr/bin/env bash
set -euo pipefail

# Fail on warnings and errors (package.json lint uses --error-on-warnings).
npm run lint
