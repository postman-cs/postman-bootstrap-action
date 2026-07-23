#!/usr/bin/env bash
set -euo pipefail

# SEA recipe for the postman-bootstrap CLI (Linux x64). Built on a native
# linux-x64 CI runner (the authoritative build); assumes deps are installed (npm ci).
# Bundles the Node runtime into a single executable so the action runs with no
# npm and no Node install on the consumer.
#
# The runtime is a PINNED, checksum-verified official Node tarball rather than the
# runner's node. Node's SEA docs require the blob's Node version to exactly match
# the binary it is injected into, but setup-node resolves "24" to whatever patch is
# current that day; pinning the exact version makes the build reproducible and
# removes that skew. The same pinned node both GENERATES the blob and RECEIVES it,
# so the versions cannot diverge. Cross-runtime injection is safe here because
# sea-config.json leaves useCodeCache and useSnapshot false (their defaults) and the
# dependency tree has no native addons -- both prerequisites per the Node SEA docs.

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

# Pinned Node runtime (Active LTS "Krypton"). Bump deliberately; must stay a real
# published release so the tarball and SHASUMS256.txt resolve.
NODE_VERSION="24.18.0"
NODE_DIST="node-v${NODE_VERSION}-linux-x64"
NODE_TARBALL="${NODE_DIST}.tar.xz"
NODE_BASE_URL="https://nodejs.org/dist/v${NODE_VERSION}"

OUT_DIR="build/sea"
BUNDLE="$OUT_DIR/cli.cjs"
BLOB="$OUT_DIR/sea-prep.blob"
VERSION="$(node -p "require('./package.json').version")"
BIN="$OUT_DIR/postman-bootstrap-${VERSION}-linux-x64"
# Fixed sentinel required by Node's SEA tooling.
FUSE="NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2"

mkdir -p "$OUT_DIR"

echo "==> fetching pinned Node runtime v${NODE_VERSION} (linux-x64)"
NODE_WORK="$OUT_DIR/node-dist"
rm -rf "$NODE_WORK"
mkdir -p "$NODE_WORK"
curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 2 \
  "${NODE_BASE_URL}/${NODE_TARBALL}" -o "$NODE_WORK/${NODE_TARBALL}"
curl -fsSL --connect-timeout 10 --max-time 120 --retry 3 --retry-delay 2 \
  "${NODE_BASE_URL}/SHASUMS256.txt" -o "$NODE_WORK/SHASUMS256.txt"

echo "==> verifying tarball against SHASUMS256.txt"
( cd "$NODE_WORK" && grep " ${NODE_TARBALL}\$" SHASUMS256.txt | shasum -a 256 -c - )

echo "==> extracting pinned node binary"
tar -xJf "$NODE_WORK/${NODE_TARBALL}" -C "$NODE_WORK" "${NODE_DIST}/bin/node"
NODE_BIN="$NODE_WORK/${NODE_DIST}/bin/node"

echo "==> bundling CLI -> $BUNDLE"
node_modules/.bin/esbuild src/cli.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --alias:jsonc-parser=jsonc-parser/lib/esm/main.js \
  --define:__SEA_VERSION__="\"${VERSION}\"" \
  --outfile="$BUNDLE"

echo "==> generating SEA blob (with the pinned node)"
"$NODE_BIN" --experimental-sea-config sea-config.json

echo "==> copying pinned node runtime -> $BIN"
cp "$NODE_BIN" "$BIN"
chmod +w "$BIN"

echo "==> injecting SEA blob (postject)"
node_modules/.bin/postject "$BIN" NODE_SEA_BLOB "$BLOB" \
  --sentinel-fuse "$FUSE"

chmod +x "$BIN"
echo "==> built: $BIN"
file "$BIN" || true
ls -lh "$BIN"
