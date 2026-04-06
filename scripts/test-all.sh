#!/usr/bin/env bash
set -euo pipefail

cd "$(dirname "$0")/.."

echo "Running full test suite..."
npm run test
