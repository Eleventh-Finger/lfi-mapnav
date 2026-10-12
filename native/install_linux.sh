#!/usr/bin/env bash
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
if ! command -v python3 >/dev/null 2>&1; then
  echo "Python 3 was not found on PATH." >&2
  exit 1
fi
DEST="$HOME/.local/share/lfi-navigator-native"
MANIFEST_DIR="$HOME/.mozilla/native-messaging-hosts"
mkdir -p "$DEST" "$MANIFEST_DIR"
cp "$ROOT/lfi_navigator_host.py" "$DEST/lfi_navigator_host.py"
chmod +x "$DEST/lfi_navigator_host.py"
cat > "$MANIFEST_DIR/lfi_navigator_transport.json" <<EOF
{
  "name": "lfi_navigator_transport",
  "description": "LFI Navigator Python native HTTP transport",
  "path": "$DEST/lfi_navigator_host.py",
  "type": "stdio",
  "allowed_extensions": ["lfi-navigator@ctf-lab.local"]
}
EOF
echo "Installed native host to $DEST"
echo "Restart Firefox after installing/reinstalling the extension."
