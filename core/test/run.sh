#!/bin/sh
if [ "$#" -ne 1 ]; then
    echo "Usage: $0 <script.ts>"
    exit 1
fi

npx ts-node --esm "$1"
