@echo off
setlocal
cd /d "%~dp0"

set "BUNDLED_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"

if exist "%BUNDLED_NODE%" (
  start "Pixel Panstwa Server" /min "%BUNDLED_NODE%" server.js
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:3000"
  exit /b 0
)

where node >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  start "Pixel Panstwa Server" /min node server.js
  timeout /t 1 /nobreak >nul
  start "" "http://localhost:3000"
  exit /b 0
)

echo Nie znaleziono Node.js.
echo Zainstaluj Node.js albo uruchom gre z aplikacji Codex.
pause
