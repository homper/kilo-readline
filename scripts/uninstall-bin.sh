#!/usr/bin/env bash
# Removes the kilo-readline launcher and its self-contained runtime directory
# from the kilo bin dir.
#
# Override the install location with: KILO_BIN_DIR=/path/to/bin ./scripts/uninstall-bin.sh
# Override the binary name with: KILO_BIN_NAME=kilo-readline ./scripts/uninstall-bin.sh
set -euo pipefail

BIN_NAME="${KILO_BIN_NAME:-kilo-readline}"

if [[ -z "${KILO_BIN_DIR:-}" ]]; then
  if command -v "$BIN_NAME" >/dev/null 2>&1; then
    KILO_BIN_DIR="$(dirname "$(command -v "$BIN_NAME")")"
  elif command -v kilo >/dev/null 2>&1; then
    KILO_BIN_DIR="$(dirname "$(command -v kilo)")"
  else
    echo "error: could not find '$BIN_NAME' or 'kilo' on PATH; set KILO_BIN_DIR to uninstall manually." >&2
    exit 1
  fi
fi

if [[ ! -d "$KILO_BIN_DIR" ]]; then
  echo "error: KILO_BIN_DIR '$KILO_BIN_DIR' is not a directory." >&2
  exit 1
fi

launcher="$KILO_BIN_DIR/$BIN_NAME"
runtime="$KILO_BIN_DIR/$BIN_NAME-runtime"
if [[ -e "$launcher" || -d "$runtime" ]]; then
  rm -f "$launcher"
  rm -rf "$runtime"
  echo "Removed: $launcher (+ $runtime)"
  echo "Uninstalled from $KILO_BIN_DIR."
else
  echo "Nothing to uninstall in $KILO_BIN_DIR."
fi
