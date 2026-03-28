#!/bin/zsh
set -e

SCRIPT_DIR="${0:A:h}"
FILES=(main.js styles.css manifest.json)

TARGETS=(
  "/Users/jd/Library/CloudStorage/ProtonDrive-jd@levier.cc-folder/obsidian vault (root)/.obsidian/plugins/streak-tracker"
  "/Users/jd/Library/Mobile Documents/iCloud~md~obsidian/Documents/obsidian vault (ios)/.obsidian/plugins/streak-tracker"
)

for target in "${TARGETS[@]}"; do
  echo "→ $target"
  mkdir -p "$target"
  for f in "${FILES[@]}"; do
    cp "$SCRIPT_DIR/$f" "$target/$f"
  done
done

echo "Done."
