@echo off
rem Draft Buddy launcher — serves the app locally and opens your browser.
title Draft Buddy
cd /d "%~dp0"
start "" "http://localhost:8199/"
where python >nul 2>nul && (python -m http.server 8199) || (npx --yes serve -l 8199 .)
