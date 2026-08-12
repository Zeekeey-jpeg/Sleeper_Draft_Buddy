#!/bin/sh
# Draft Buddy launcher — serves the app locally and opens your browser.
cd "$(dirname "$0")"
( sleep 1; open "http://localhost:8199/" 2>/dev/null || xdg-open "http://localhost:8199/" 2>/dev/null ) &
python3 -m http.server 8199 2>/dev/null || npx --yes serve -l 8199 .
