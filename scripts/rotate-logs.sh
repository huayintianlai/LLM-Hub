#!/bin/bash
set -euo pipefail

LOG_DIR="$(pwd)/logs"
TARGET_FILE="$LOG_DIR/gateway.log"

if [[ ! -f "$TARGET_FILE" ]]; then
  echo "No gateway log file found; nothing to rotate."
  exit 0
fi

TIMESTAMP=$(date +"%Y%m%d-%H%M%S")
ARCHIVE="$LOG_DIR/gateway.$TIMESTAMP.log"

mv "$TARGET_FILE" "$ARCHIVE"
touch "$TARGET_FILE"

echo "Rotated gateway log: $ARCHIVE"
