#!/usr/bin/env bash
# deploy.sh — build, package, install and reload the extension in one step
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
EXT="$ROOT/extension"

# 1. build MCP server
echo "[1/4] Building MCP server..."
cd "$ROOT" && npm run build

# 2. build + package extension
echo "[2/4] Building and packaging extension..."
cd "$EXT" && npm run build
VERSION=$(node -p "require('./package.json').version")
VSIX="$EXT/cursor-mcp-bridge-$VERSION.vsix"
npx @vscode/vsce package --no-dependencies --out "$VSIX" 2>/dev/null

echo "      Packaged: cursor-mcp-bridge-$VERSION.vsix"

# 3. remove old versions + install new one
echo "[3/4] Cleaning old versions and installing $VERSION..."
EXTENSIONS_DIR="$USERPROFILE/.cursor/extensions"
if [ -d "$EXTENSIONS_DIR" ]; then
  for old in "$EXTENSIONS_DIR"/kloutdevs.cursor-mcp-bridge-*; do
    [ -d "$old" ] && [ "$(basename "$old")" != "kloutdevs.cursor-mcp-bridge-$VERSION" ] && rm -rf "$old" && echo "      Removed $(basename "$old")"
  done
fi
cursor --install-extension "$VSIX"

# 4. reload Cursor window so the new extension activates
BRIDGE_PORT="${MCP_BRIDGE_PORT:-9421}"
echo "[4/4] Reloading Cursor window (port $BRIDGE_PORT)..."
curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/command" \
  -H "Content-Type: application/json" \
  -d '{"command":"workbench.action.reloadWindow"}' > /dev/null || true

echo ""
echo "Done. Waiting for bridge to come back up..."
sleep 12

STATUS=$(curl -s "http://127.0.0.1:$BRIDGE_PORT/status" 2>/dev/null || echo "{}")
echo "Bridge status: $STATUS"
