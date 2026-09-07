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
npx @vscode/vsce package --out "$VSIX" 2>/dev/null

echo "      Packaged: cursor-mcp-bridge-$VERSION.vsix"

# 3. remove old versions + install new one
echo "[3/4] Cleaning old versions and installing $VERSION..."
if [ -n "$USERPROFILE" ]; then
  EXTENSIONS_DIR="$USERPROFILE/.cursor/extensions"
else
  EXTENSIONS_DIR="$HOME/.cursor/extensions"
fi
if [ -d "$EXTENSIONS_DIR" ]; then
  for old in "$EXTENSIONS_DIR"/kloutdevs.cursor-mcp-bridge-*; do
    [ -d "$old" ] && [ "$(basename "$old")" != "kloutdevs.cursor-mcp-bridge-$VERSION" ] && rm -rf "$old" && echo "      Removed $(basename "$old")"
  done
fi
cursor --install-extension "$VSIX"

# 4. reload Cursor window so the new extension activates
# Prefer explicit MCP_BRIDGE_PORT; otherwise pick the live registry entry for this repo.
REGISTRY="${HOME}/.vscode-mcp-bridge/registry.json"
if [ -n "${MCP_BRIDGE_PORT:-}" ]; then
  BRIDGE_PORT="$MCP_BRIDGE_PORT"
elif [ -f "$REGISTRY" ]; then
  BRIDGE_PORT=$(python3 - <<'PY'
import json, os
reg=json.load(open(os.path.expanduser("~/.vscode-mcp-bridge/registry.json")))
# Prefer vscode-mcp workspace; else first live entry
prefer=[p for p,v in reg.items() if v.get("workspace")=="vscode-mcp"]
print(prefer[0] if prefer else (next(iter(reg), "") or ""))
PY
)
else
  BRIDGE_PORT="9421"
fi

echo "[4/4] Reloading Cursor window (port $BRIDGE_PORT)..."
if [ -n "$BRIDGE_PORT" ]; then
  curl -s -X POST "http://127.0.0.1:$BRIDGE_PORT/command" \
    -H "Content-Type: application/json" \
    -d '{"command":"workbench.action.reloadWindow"}' > /dev/null || true
fi

echo ""
echo "Done. Waiting for bridge to come back up..."
# Ephemeral ports change after reload — poll the registry for vscode-mcp.
for i in $(seq 1 20); do
  sleep 2
  NEW_PORT=$(python3 - <<'PY'
import json, os
try:
  reg=json.load(open(os.path.expanduser("~/.vscode-mcp-bridge/registry.json")))
except Exception:
  print(""); raise SystemExit
prefer=[p for p,v in reg.items() if v.get("workspace")=="vscode-mcp"]
print(prefer[0] if prefer else "")
PY
)
  if [ -n "$NEW_PORT" ]; then
    STATUS=$(curl -s --max-time 2 "http://127.0.0.1:$NEW_PORT/status" 2>/dev/null || echo "")
    if echo "$STATUS" | grep -q '"active"'; then
      echo "Bridge status: $STATUS"
      exit 0
    fi
  fi
done
echo "Bridge status: {} (timed out waiting for registry)"
exit 1
