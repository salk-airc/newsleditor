#!/usr/bin/env bash
# Removes what install.sh put on this Mac:  bash uninstall.sh [--keep-data]
#
# Stops newsleditor and its tunnel, removes their LaunchAgents, and deletes
# ~/Library/Application Support/newsleditor, the newsletter's data included
# unless --keep-data (then only data/ and newsleditor.env stay).

set -euo pipefail

HOME_DIR="${NEWSLEDITOR_HOME:-$HOME/Library/Application Support/newsleditor}"
LABEL="${NEWSLEDITOR_LABEL:-org.newsleditor}"
AGENTS="$HOME/Library/LaunchAgents"
uid="$(id -u)"

for job in app tunnel; do
  if launchctl bootout "gui/$uid/$LABEL.$job" 2>/dev/null; then echo "Stopped $job."; fi
  rm -f "$AGENTS/$LABEL.$job.plist"
done

if [[ "${1:-}" == "--keep-data" ]]; then
  find "$HOME_DIR" -mindepth 1 -maxdepth 1 ! -name data ! -name newsleditor.env -exec rm -rf {} +
  echo "Kept $HOME_DIR/data and its settings."
else
  rm -rf "$HOME_DIR"
  echo "Removed $HOME_DIR."
fi
echo "newsleditor is uninstalled."
