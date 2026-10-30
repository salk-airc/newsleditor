#!/bin/bash
# Double-click to install newsleditor (or update it) from a setup code.
# Runs install.sh from this folder, or downloads it if this file is on its own.
# (If macOS says it's from an unidentified developer: right-click it, choose Open.)
here="$(cd "$(dirname "$0")" && pwd)"
if [[ -f "$here/install.sh" ]]; then
  bash "$here/install.sh"
else
  curl -fsSL https://raw.githubusercontent.com/salk-airc/newsleditor/main/installer/mac/install.sh | bash
fi
echo
read -r -p "Press Enter to close this window."
