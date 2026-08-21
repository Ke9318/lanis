#!/bin/sh
set -eu
cd "$(dirname "$0")/.."
node scripts/build.js "$@"
