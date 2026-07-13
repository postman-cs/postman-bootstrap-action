#!/usr/bin/env bash
set -euo pipefail

# SEA recipe for the postman-bootstrap CLI (Linux x64).
# Bundles the Node runtime into a single executable so the action runs with no
# npm and no Node install on the consumer. Runs inside the linux/amd64 build
# container (see Dockerfile), or directly on a native linux runner in CI.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

OUT_DIR="build/sea"
BUNDLE="$OUT_DIR/cli.cjs"
BLOB="$OUT_DIR/sea-prep.blob"
BIN="$OUT_DIR/postman-bootstrap-linux-x64"
# Fixed sentinel required by Node's SEA tooling.
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

mkdir -p "$OUT_DIR"

echo "==> bundling CLI -> $BUNDLE"
node_modules/.bin/esbuild src/cli.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --alias:jsonc-parser=jsonc-parser/lib/esm/main.js \
  --outfile="$BUNDLE"

echo "==> generating SEA blob"
node --experimental-sea-config sea-config.json

echo "==> copying node runtime -> $BIN"
cp "$(command -v node)" "$BIN"
chmod +w "$BIN"

echo "==> injecting SEA blob (postject)"
node_modules/.bin/postject "$BIN" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse "$FUSE"

chmod +x "$BIN"
echo "==> built: $BIN"
file "$BIN" || true
ls -lh "$BIN"
