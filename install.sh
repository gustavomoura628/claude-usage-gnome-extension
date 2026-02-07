#!/bin/bash
set -e

DEST="$HOME/.local/share/gnome-shell/extensions/claude-usage@local"
SRC="$(cd "$(dirname "$0")" && pwd)"

mkdir -p "$DEST"
cp "$SRC"/metadata.json "$SRC"/*.js "$SRC"/stylesheet.css "$DEST"/

echo "Installed to $DEST"

gnome-extensions enable claude-usage@local 2>/dev/null || true

echo "Done. Extension installed and enabled."
echo "Restarting GNOME Shell..."
killall -3 gnome-shell 2>/dev/null || echo "Could not restart GNOME Shell. Log out and back in for changes to take effect."
