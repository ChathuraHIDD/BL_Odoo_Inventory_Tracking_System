#!/bin/bash
# BatteryLab Stock Count: double-click to start on macOS.
cd "$(dirname "$0")"
PORT=8080
echo "Starting BatteryLab Stock Count on http://localhost:$PORT  (close this window to stop)"
( sleep 1 && open "http://localhost:$PORT" ) &
python3 -m http.server $PORT --bind 127.0.0.1
