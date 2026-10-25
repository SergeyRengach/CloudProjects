#!/bin/bash
# macOS: подвійний клік. Linux: ./start.command
cd "$(dirname "$0")"
if command -v python3 >/dev/null 2>&1; then exec python3 serve.py; fi
echo "Потрібен Python 3 (macOS: встановіть Xcode Command Line Tools: xcode-select --install)."
read -n 1 -s -r -p "Натисніть будь-яку клавішу…"
