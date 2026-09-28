#!/bin/bash
exec 2>/dev/null

# Use a unique temporary directory
TMP_DIR=$(mktemp -d 2>/dev/null || mktemp -d -t 'claude-extract')

# Function to clean up on exit
cleanup() {
    rm -rf "$TMP_DIR"
}
trap cleanup EXIT

cd "$TMP_DIR" || { echo '[]'; exit 0; }

TARBALL=$(npm pack @anthropic-ai/claude-code@latest) || { echo '[]'; exit 0; }
tar -xzf "$TARBALL" || { echo '[]'; exit 0; }

# NOTE: This extraction assumes that ./package/cli.js contains a single object literal
# with model constants (e.g., OPUS_ID, OPUS_NAME, SONNET_ID, SONNET_NAME, etc.) defined
# together in one place. If the CLI refactors these constants (renames, reorders, or
# moves them to separate declarations), this pattern may stop working and should be
# updated accordingly.
RESULT=$(grep 'OPUS_ID.*SONNET_ID\|SONNET_ID.*OPUS_ID' ./package/cli.js | \
  grep -o '{OPUS_ID:"[^"]*",OPUS_NAME:"[^"]*",SONNET_ID:"[^"]*",SONNET_NAME:"[^"]*"[^}]*}' | \
  sed 's/\([A-Z_]*\):/"\1":/g' | \
  jq -c '[to_entries[] | select(.key | endswith("_ID")) | .value] | unique') || { echo '[]'; exit 0; }

echo "${RESULT:-[]}"
