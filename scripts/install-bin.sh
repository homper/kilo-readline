#!/usr/bin/env bash
# Builds the kilo-readline client and installs it next to the `kilo` binary so it is
# available on PATH. The compiled JS is copied together with its only runtime
# dependency (@agentclientprotocol/sdk, which needs zod) into a self-contained
# directory, and a `kilo-readline` launcher script is written into the kilo bin dir.
#
# Override the install location with: KILO_BIN_DIR=/path/to/bin ./scripts/install-bin.sh
# Override the binary name with: KILO_BIN_NAME=kilo-readline ./scripts/install-bin.sh
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

BIN_NAME="${KILO_BIN_NAME:-kilo-readline}"
RUNTIME_DIR_NAME="${BIN_NAME}-runtime"

# Locate the kilo bin directory.
if [[ -z "${KILO_BIN_DIR:-}" ]]; then
  if ! command -v kilo >/dev/null 2>&1; then
    echo "error: could not find 'kilo' on PATH; set KILO_BIN_DIR to install manually." >&2
    exit 1
  fi
  KILO_BIN_DIR="$(dirname "$(command -v kilo)")"
fi

if [[ ! -d "$KILO_BIN_DIR" ]]; then
  echo "error: KILO_BIN_DIR '$KILO_BIN_DIR' is not a directory." >&2
  exit 1
fi

echo "Building..."
npm run build --silent

echo "Installing into $KILO_BIN_DIR"
RUNTIME_DIR="$KILO_BIN_DIR/$RUNTIME_DIR_NAME"
LAUNCHER="$KILO_BIN_DIR/$BIN_NAME"

# Remove any previously installed launcher/runtime for this binary name so an
# install always leaves a single clean copy.
rm -f "$LAUNCHER"
rm -rf "$RUNTIME_DIR"
mkdir -p "$RUNTIME_DIR/node_modules"

# Mark the runtime as an ES module so Node doesn't warn about a typeless
# package.json and reparse with overhead.
cat > "$RUNTIME_DIR/package.json" <<EOF
{"private": true, "type": "module"}
EOF

cp dist/*.js "$RUNTIME_DIR/"

# Vendor the only runtime dependency (+ its peer dep zod).
cp -R node_modules/@agentclientprotocol "$RUNTIME_DIR/node_modules/"
cp -R node_modules/zod "$RUNTIME_DIR/node_modules/"

cat > "$LAUNCHER" <<EOF
#!/bin/sh
exec node "\$(dirname "\$0")/$RUNTIME_DIR_NAME/index.js" "\$@"
EOF
chmod +x "$LAUNCHER"

echo "Installed: $LAUNCHER"
echo "Run with: $BIN_NAME"
