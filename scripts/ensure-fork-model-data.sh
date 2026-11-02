#!/bin/sh
# Stays bash-free: minimal images (Alpine, busybox) ship no bash.
set -eu

cd "$(dirname "$0")/../vendor/pi"

# A cached catalog cannot prove that the remote provider list is unchanged.
npm run hydrate:model-data
npm run check:model-data
