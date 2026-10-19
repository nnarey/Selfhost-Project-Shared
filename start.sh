#!/bin/bash
# Convenience launcher for local development (web + optional local API).
#
# Uses your system Node.js if it's on PATH; otherwise falls back to the
# local Node.js runtime downloaded into .tools/ (see README for details).
set -e
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if ! command -v npm >/dev/null 2>&1; then
  BUNDLED_NODE="$ROOT_DIR/.tools/node-v22.14.0-darwin-arm64/bin"
  if [ -d "$BUNDLED_NODE" ]; then
    export PATH="$BUNDLED_NODE:$PATH"
  else
    echo "Node.js not found. Install Node 22 from https://nodejs.org and re-run this script." >&2
    exit 1
  fi
fi

# A fresh clone has no server/.env.local (it is gitignored). Without it the API falls back to
# port 8080 and the UI cannot reach it, so seed it from the sample.
if [ ! -f "$ROOT_DIR/server/.env.local" ]; then
  cp "$ROOT_DIR/server/.env.example" "$ROOT_DIR/server/.env.local"
  echo "Created server/.env.local from server/.env.example"
fi

START_API=1
if [ "${1:-}" = "--web-only" ]; then
  START_API=0
fi

if [ "$START_API" = "1" ]; then
  cd "$ROOT_DIR/server"
  if [ ! -d node_modules ]; then
    echo "Installing server dependencies..."
    npm install
  fi
  echo "Starting local API on http://localhost:8787"
  npm run dev &
  API_PID=$!
  trap 'kill $API_PID 2>/dev/null || true' EXIT
fi

cd "$ROOT_DIR/web"
if [ ! -d node_modules ]; then
  echo "Installing web dependencies..."
  npm install
fi

echo "Starting FieldCam Self-Host on http://localhost:5173"
echo "  Leaderboard: http://localhost:5173/#/leaderboard"
echo "  Admin:       http://localhost:5173/#/admin"
npm run dev
