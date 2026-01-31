#!/bin/bash
set -e

DEST="$HOME/.local/share/gnome-shell/extensions/claude-usage@local"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST"
cp "$SRC"/metadata.json "$SRC"/*.js "$SRC"/stylesheet.css "$DEST"/

echo "Installed to $DEST"

gnome-extensions enable claude-usage@local 2>/dev/null || true
killall -HUP gnome-shell 2>/dev/null || true

echo "Done. Extension enabled and shell restarted."
