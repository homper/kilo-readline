#!/usr/bin/env bash
# Run kilo-readline against a locally-built goose ACP agent instead of kilo.
#
# Usage: scripts/run-goose.sh [extra args for dist/index.js]
#
# Override locations via env if needed:
#   GOOSE_DIR       path to the goose checkout (default: sibling of this repo)
#   GOOSE_BIN       explicit goose-acp binary path
#   GOOSE_AGENT_ARGS args passed to the agent (default: --with-builtin developer)
#
# Startup tracing is on by default; unset KILO_TRACE_STARTUP to silence it.
set -euo pipefail

ROOT="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
GOOSE_DIR="${GOOSE_DIR:-$ROOT/../goose}"

if [ -z "${GOOSE_BIN:-}" ]; then
  for candidate in \
    "$GOOSE_DIR/target/release/goose-acp" \
    "$GOOSE_DIR/target/debug/goose-acp" \
    "$GOOSE_DIR/target/release/goose" \
    "$GOOSE_DIR/target/debug/goose"; do
    if [ -x "$candidate" ]; then
      GOOSE_BIN="$candidate"
      break
    fi
  done
fi

if [ -z "${GOOSE_BIN:-}" ]; then
  echo "goose binary not found under $GOOSE_DIR/target" >&2
  echo "build it first: (cd \"$GOOSE_DIR\" && cargo build --release -p goose --bin goose-acp)" >&2
  exit 1
fi

if [ ! -f "$ROOT/dist/index.js" ]; then
  (cd "$ROOT" && npm run build)
fi

# Derive the GLM Coding Plan API key from kilo's auth file
# ($XDG_DATA_HOME/kilo/auth.json, `zai-coding-plan` section) and point goose's
# zai_coding_plan provider at it. Nothing is written to disk; the key only
# travels via environment variables to the goose process.
if [ -z "${ZAI_CODING_PLAN_API_KEY:-}" ]; then
  ZAI_CODING_PLAN_API_KEY="$(node -e '
    const fs = require("fs"), os = require("os"), path = require("path");
    const dir = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share");
    const p = path.join(dir, "kilo", "auth.json");
    try {
      const all = JSON.parse(fs.readFileSync(p, "utf8"));
      for (const name of ["zai-coding-plan", "zai"]) {
        const s = all[name];
        if (s && s.type === "api" && typeof s.key === "string") {
          process.stdout.write(s.key);
          break;
        }
      }
    } catch {}
  ')"
  if [ -n "$ZAI_CODING_PLAN_API_KEY" ]; then
    export ZAI_CODING_PLAN_API_KEY
  else
    echo "warning: no GLM Coding Plan key in kilo auth.json — set ZAI_CODING_PLAN_API_KEY to use it" >&2
  fi
fi

export GOOSE_PROVIDER="${GOOSE_PROVIDER:-zai_coding_plan}"
export GOOSE_MODEL="${GOOSE_MODEL:-glm-5.3}"

export KILO_AGENT_CMD="$GOOSE_BIN"
if [ -z "${GOOSE_AGENT_ARGS:-}" ]; then
  case "$(basename "$GOOSE_BIN")" in
    goose-acp) GOOSE_AGENT_ARGS="--with-builtin developer" ;;
    *) GOOSE_AGENT_ARGS="acp --with-builtin developer" ;;
  esac
fi
export KILO_AGENT_ARGS="$GOOSE_AGENT_ARGS"
export KILO_TRACE_STARTUP="${KILO_TRACE_STARTUP:-1}"

exec node "$ROOT/dist/index.js" "$@"
