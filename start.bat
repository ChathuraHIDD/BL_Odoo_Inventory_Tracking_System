@echo off
REM BatteryLab Stock Count: double-click to start on Windows (needs Python 3).
cd /d "%~dp0"
echo Starting BatteryLab Stock Count on http://localhost:8080  (close this window to stop)
start "" http://localhost:8080
python -m http.server 8080 --bind 127.0.0.1
