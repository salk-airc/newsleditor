#!/usr/bin/env bash
# Install newsleditor and start it, on a Mac or Linux computer:
#
#   curl -fsSL https://raw.githubusercontent.com/salk-airc/newsleditor/main/install.sh | bash
#
# It checks for git and Node.js 22.18 or newer (installing Node with Homebrew
# when it can), downloads newsleditor into ~/newsleditor, installs it, starts
# it and opens it in the browser. Run it again later to update.
#
#   NEWSLEDITOR_DIR=~/somewhere-else   install somewhere else
#   PORT=4322                          use another port
#   NO_START=1                         install or update, but don't start

set -euo pipefail

REPO="${NEWSLEDITOR_REPO:-https://github.com/salk-airc/newsleditor.git}"
DIR="${NEWSLEDITOR_DIR:-$HOME/newsleditor}"
PORT="${PORT:-4321}"

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

# Run as ./install.sh from a checkout, use that checkout as it is (no update).
CHECKOUT=""
here=""
[[ -f "${BASH_SOURCE[0]:-}" ]] && here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [[ -z "${NEWSLEDITOR_DIR:-}" && -n "$here" && -f "$here/server.mjs" && -f "$here/package.json" ]]; then
  DIR="$here"
  CHECKOUT=1
fi

# Node 22.18 or newer: server.mjs imports TypeScript, which Node strips from 22.18.
node_ok() {
  command -v node >/dev/null &&
    node -e 'const [a,b]=process.versions.node.split(".").map(Number);process.exit(a>22||(a===22&&b>=18)?0:1)'
}

say "Checking for Node.js 22.18 or newer"
if ! node_ok; then
  if command -v brew >/dev/null; then
    echo "Installing Node.js with Homebrew..."
    brew install node
  fi
  node_ok || fail "newsleditor needs Node.js 22.18 or newer$(command -v node >/dev/null && echo " (you have $(node -v))").
Install the LTS version from https://nodejs.org, then run this again."
fi
echo "Node.js $(node -v)"

command -v git >/dev/null || fail "newsleditor needs git.
On a Mac, run: xcode-select --install
On Linux, install it with your package manager (for example: sudo apt install git).
Then run this again."

if [[ -n "$CHECKOUT" ]]; then
  say "Using newsleditor in $DIR"
elif [[ -d "$DIR/.git" ]]; then
  say "Updating newsleditor in $DIR"
  git -C "$DIR" pull --ff-only || fail "Couldn't update $DIR with git pull. Update it by hand, or set NEWSLEDITOR_DIR to install a fresh copy elsewhere."
elif [[ -e "$DIR" ]]; then
  fail "$DIR already exists and isn't newsleditor. Set NEWSLEDITOR_DIR to install somewhere else."
else
  say "Downloading newsleditor into $DIR"
  git clone --depth 1 "$REPO" "$DIR"
fi

cd "$DIR"

say "Installing (a minute or so)"
npm ci --no-audit --no-fund --loglevel=error

if [[ -n "${NO_START:-}" ]]; then
  say "Installed. To start it: cd \"$DIR\" && npm start"
  exit 0
fi

if curl -sf -o /dev/null "http://localhost:$PORT/favicon.svg"; then
  fail "Something is already running on port $PORT (perhaps newsleditor itself: try http://localhost:$PORT).
To use another port, set PORT (for example PORT=4322) and run this again."
fi

URL="http://localhost:$PORT"

# Open the browser once the site answers (the first start builds it first).
(
  for _ in $(seq 1 120); do
    if curl -sf -o /dev/null "$URL/favicon.svg"; then
      if command -v open >/dev/null; then open "$URL"
      elif command -v xdg-open >/dev/null; then xdg-open "$URL" >/dev/null 2>&1
      fi
      exit 0
    fi
    sleep 1
  done
) &

say "Starting newsleditor at $URL"
cat <<EOF
Your browser opens there when it's ready. The first visit walks you through
setting up your account and the newsletter.

Keep this window open while you use it; press Ctrl+C to stop.
Next time, start it with:  cd "$DIR" && npm start
EOF

PORT="$PORT" exec npm start
