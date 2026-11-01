#!/usr/bin/env bash
set -euo pipefail

# Build the fork before typechecking or testing packages that import its SDK.
exec bun run check
