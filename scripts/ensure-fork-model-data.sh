#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "${BASH_SOURCE[0]}")/../vendor/pi"

# A cached catalog cannot prove that the remote provider list is unchanged.
npm run hydrate:model-data
npm run check:model-data
