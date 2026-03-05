#!/bin/bash

# Launch Tajarib Dashboard
cd "$(dirname "$0")"

echo "Starting Tajarib Dashboard..."
echo ""

# Open browser after a short delay (gives the server time to start)
(sleep 2 && open "http://localhost:7430") &

# Start the server (this keeps running until you close the window)
node dashboard.js
