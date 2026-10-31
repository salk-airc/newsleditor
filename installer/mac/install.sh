#!/usr/bin/env bash
# Installs newsleditor on a Mac from a setup code, or updates it. No admin
# password needed: everything goes in your user account.
#
#   Double-click "Install newsleditor.command" (next to this file), or paste into Terminal:
#     curl -fsSL https://raw.githubusercontent.com/salk-airc/newsleditor/main/installer/mac/install.sh | bash
#
# 1. Asks for the setup code (a small window). Run again and leave it empty to
#    update newsleditor and keep its settings.
# 2. Gets Node.js (the current LTS, checked against nodejs.org's checksums) and
#    newsleditor, writes its settings from the code, and builds it.
# 3. If the code has a tunnel token, gets cloudflared, so the newsletter is at
#    its address.
# 4. Starts both at login and whenever they stop (LaunchAgents), starts them
#    now, and opens the address.
#
# Everything is in ~/Library/Application Support/newsleditor: node/, app/,
# cloudflared, newsleditor.env (its settings; only you can read it), data/
# (the newsletter: back this up) and logs/. It runs while you're logged in on
# this Mac, so keep it logged in, and set it not to sleep while your team writes.
#
# Options (environment variables): SETUP_CODE=setup1.… (instead of the window),
# NEWSLEDITOR_UPDATE=1 (update without asking), NEWSLEDITOR_SOURCE=<.tar.gz>
# (newsleditor itself; default the main branch on GitHub). For testing:
# NEWSLEDITOR_HOME, NEWSLEDITOR_LABEL, NEWSLEDITOR_PORT.

set -euo pipefail

HOME_DIR="${NEWSLEDITOR_HOME:-$HOME/Library/Application Support/newsleditor}"
LABEL="${NEWSLEDITOR_LABEL:-org.newsleditor}"
PORT="${NEWSLEDITOR_PORT:-4321}"
SOURCE="${NEWSLEDITOR_SOURCE:-https://codeload.github.com/salk-airc/newsleditor/tar.gz/refs/heads/main}"
AGENTS="$HOME/Library/LaunchAgents"
CONFIG="$HOME_DIR/newsleditor.env"
NODE_DIR="$HOME_DIR/node"
APP_DIR="$HOME_DIR/app"
# Node.js versions it installs: 22.18+ (newsleditor imports TypeScript), and no
# newer major than better-sqlite3 has ready-made builds for.
MAX_NODE_MAJOR=26

say() { printf '\n\033[1m%s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m%s\033[0m\n' "$*" >&2; exit 1; }

[[ "$(uname -s)" == Darwin ]] || fail "This installer is for macOS. On Linux, see the README."
case "$(uname -m)" in
  arm64) NODE_ARCH=arm64; CF_ARCH=arm64 ;;
  x86_64) NODE_ARCH=x64; CF_ARCH=amd64 ;;
  *) fail "Unsupported Mac: $(uname -m)" ;;
esac

mkdir -p "$HOME_DIR/data" "$HOME_DIR/logs" "$AGENTS"
chmod 700 "$HOME_DIR"

# ------------------------------------------------------------ setup code --

have_config=""; [[ -f "$CONFIG" ]] && have_config=1
code="${SETUP_CODE:-}"
if [[ -n "${NEWSLEDITOR_UPDATE:-}" ]]; then
  [[ -n "$have_config" ]] || fail "There's nothing to update: install it with a setup code first."
elif [[ -z "$code" ]]; then
  prompt="Paste the setup code you were given for this newsletter."
  [[ -n "$have_config" ]] && prompt="Paste a new setup code, or leave it empty to update newsleditor and keep its settings."
  # The answer comes back on stdout; Cancel exits.
  code="$(osascript -e "text returned of (display dialog \"$prompt\" default answer \"\" with title \"Install newsleditor\" buttons {\"Cancel\", \"Install\"} default button \"Install\")" 2>/dev/null)" ||
    { echo "Cancelled."; exit 0; }
fi
code="$(printf '%s' "$code" | tr -d '[:space:]')"
if [[ -n "$code" && "$code" != setup1.* ]]; then
  fail "That isn't a setup code: it should start with setup1. Copy it again from the page that gave it to you."
fi
[[ -n "$code" || -n "$have_config" ]] || fail "newsleditor needs a setup code to install."

# --------------------------------------------------------------- node.js --

node_ok() {
  [[ -x "$NODE_DIR/bin/node" ]] &&
    "$NODE_DIR/bin/node" -e "const [a,b]=process.versions.node.split('.').map(Number);process.exit((a>22||(a===22&&b>=18))&&a<=$MAX_NODE_MAJOR?0:1)"
}
if ! node_ok; then
  say "Getting Node.js"
  # Read in full, then searched without a pipe: awk stops at the first match,
  # and whatever was writing into the pipe would fail the install (pipefail).
  index_tab="$(curl -fsSL https://nodejs.org/dist/index.tab)" || fail "Couldn't reach nodejs.org."
  version="$(awk -F'\t' -v arch="osx-$NODE_ARCH-tar" -v max="$MAX_NODE_MAJOR" '
    NR > 1 && $10 != "-" && $1 ~ /^v[0-9]+\.[0-9]+\.[0-9]+$/ && index($3, arch) {
      split(substr($1, 2), v, ".")
      if ((v[1] > 22 || (v[1] == 22 && v[2] >= 18)) && v[1] <= max) { print $1; exit }
    }' <<< "$index_tab")"
  [[ -n "$version" ]] || fail "Couldn't find a Node.js release to install."
  name="node-$version-darwin-$NODE_ARCH"
  tmp="$(mktemp -d)"
  curl -fsSL "https://nodejs.org/dist/$version/$name.tar.gz" -o "$tmp/node.tar.gz"
  want="$(curl -fsSL "https://nodejs.org/dist/$version/SHASUMS256.txt" | awk -v f="$name.tar.gz" '$2 == f { print $1 }')"
  [[ "$(shasum -a 256 "$tmp/node.tar.gz" | awk '{print $1}')" == "$want" ]] || fail "The Node.js download didn't match its checksum. Try again."
  tar -xzf "$tmp/node.tar.gz" -C "$tmp"
  rm -rf "$NODE_DIR"
  mv "$tmp/$name" "$NODE_DIR"
  rm -rf "$tmp"
  echo "Node.js $version"
fi
export PATH="$NODE_DIR/bin:$PATH"
NODE="$NODE_DIR/bin/node"

# ----------------------------------------------------------- newsleditor --

say "Getting newsleditor"
uid="$(id -u)"
launchctl bootout "gui/$uid/$LABEL.app" 2>/dev/null || true
tmp="$(mktemp -d)"
if [[ -f "$SOURCE" ]]; then cp "$SOURCE" "$tmp/app.tar.gz"; else curl -fsSL "$SOURCE" -o "$tmp/app.tar.gz"; fi
tar -xzf "$tmp/app.tar.gz" -C "$tmp"
inner="$(find "$tmp" -mindepth 1 -maxdepth 1 -type d -print -quit)"
[[ -f "$inner/package.json" ]] || fail "That download isn't newsleditor."
rm -rf "$APP_DIR"
mv "$inner" "$APP_DIR"
rm -rf "$tmp"

# Its settings: from the code when there is one, else the ones already here.
# Decoded with node (base64url JSON); written so only you can read them.
if [[ -n "$code" ]]; then
  umask 077
  SETUP_CODE="$code" DATA="$HOME_DIR/data" PORT="$PORT" "$NODE" -e '
    let c;
    try { c = JSON.parse(Buffer.from(process.env.SETUP_CODE.slice(7), "base64url").toString("utf8")); } catch {}
    if (!c || !c.url || !c.env) { console.error("That setup code is damaged. Copy it again from the page that gave it to you."); process.exit(1); }
    const lines = ["# newsleditor'"'"'s settings, from its setup code. Written by the installer; a new code replaces them."];
    for (const [k, v] of Object.entries(c.env)) lines.push(`${k}=${v}`);
    lines.push(`DATA_DIR=${process.env.DATA}`, `PORT=${process.env.PORT}`, "HOST=localhost");
    require("fs").writeFileSync(process.argv[1], lines.join("\n") + "\n", { mode: 0o600 });
    require("fs").writeFileSync(process.argv[2], c.tunnelToken ?? "", { mode: 0o600 });
  ' "$CONFIG" "$HOME_DIR/tunnel-token" || exit 1
  umask 022
fi
cp "$CONFIG" "$APP_DIR/.env"
chmod 600 "$APP_DIR/.env"
url="$(sed -n 's/^SITE_URL=//p' "$CONFIG")"

say "Installing and building newsleditor (a few minutes)"
(cd "$APP_DIR" && npm_config_update_notifier=false "$NODE_DIR/bin/npm" ci --no-audit --no-fund --loglevel=error) ||
  fail "Installing newsleditor's packages failed."
(cd "$APP_DIR" && "$NODE" node_modules/astro/bin/astro.mjs build) || fail "Building newsleditor failed."

# --------------------------------------------------------------- the tunnel --

agent() { # label program args… : a LaunchAgent that runs at login and restarts when it stops
  local label="$1"; shift
  local plist="$AGENTS/$label.plist" args=""
  for a in "$@"; do args+="<string>$(printf '%s' "$a" | sed 's/&/\&amp;/g; s/</\&lt;/g')</string>"; done
  cat > "$plist" <<EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$label</string>
  <key>ProgramArguments</key><array>$args</array>
  <key>WorkingDirectory</key><string>$APP_DIR</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>30</integer>
  <key>StandardOutPath</key><string>$HOME_DIR/logs/${label##*.}.log</string>
  <key>StandardErrorPath</key><string>$HOME_DIR/logs/${label##*.}.log</string>
</dict></plist>
EOF
  chmod 600 "$plist"
  launchctl bootout "gui/$uid/$label" 2>/dev/null || true
  launchctl bootstrap "gui/$uid" "$plist"
}

token="$(cat "$HOME_DIR/tunnel-token" 2>/dev/null || true)"
if [[ -n "$token" ]]; then
  say "Connecting it to $url"
  if [[ ! -x "$HOME_DIR/cloudflared" || -n "$code" ]]; then
    tmp="$(mktemp -d)"
    curl -fsSL "https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-darwin-$CF_ARCH.tgz" -o "$tmp/cf.tgz"
    tar -xzf "$tmp/cf.tgz" -C "$tmp"
    mv "$tmp/cloudflared" "$HOME_DIR/cloudflared"
    chmod 755 "$HOME_DIR/cloudflared"
    rm -rf "$tmp"
  fi
  # The token is read from a file only you can read, not written into the plist.
  agent "$LABEL.tunnel" "$HOME_DIR/cloudflared" tunnel --no-autoupdate run --token-file "$HOME_DIR/tunnel-token"
else
  # A code without a tunnel replaces one with: stop the old one.
  launchctl bootout "gui/$uid/$LABEL.tunnel" 2>/dev/null || true
  rm -f "$AGENTS/$LABEL.tunnel.plist"
fi

# ----------------------------------------------------------- start at login --

say "Making it start when you log in"
agent "$LABEL.app" "$NODE" "$APP_DIR/scripts/start.mjs"

for _ in $(seq 1 90); do
  curl -sf -o /dev/null "http://localhost:$PORT/favicon.svg" && break
  sleep 2
done
curl -sf -o /dev/null "http://localhost:$PORT/favicon.svg" ||
  fail "newsleditor didn't start. Its log: $HOME_DIR/logs/app.log"

open_url="${url:-http://localhost:$PORT}"
say "Done: newsleditor is running at $open_url"
echo "It starts by itself when you log in to this Mac. Keep this Mac on and awake while your team writes: that's where the newsletter lives."
echo "To update it later, run the installer again and leave the setup code empty."
# With sign-in through an organisation, straight to it: that's how the Admin gets in.
grep -q '^OIDC_ISSUER=' "$CONFIG" && open_url="$open_url/_emdash/api/auth/oidc/login?next=/newsletter/edit"
[[ -n "${NEWSLEDITOR_NO_OPEN:-}" ]] || open "$open_url"
