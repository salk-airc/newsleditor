#!/usr/bin/env bash
# Connect Claude Code to this newsletter, from a terminal. (The Settings page,
# /newsletter/setup, does the same with a button: use that if you can.)
#
#   npm run connect-claude                     # with the server running
#   npm run connect-claude -- --disconnect
#
# It approves the newsletter plugin's MCP tools, makes an API token for
# Claude, and adds the site's MCP server to Claude Code for your user.
#
# On a server you're signed in to as an Admin, set ADMIN_TOKEN to an admin
# API token (made in the admin under Settings > API tokens). Without one it
# uses EmDash's dev sign-in, which only works on `npm run dev`.

set -euo pipefail

BASE="${BASE:-http://localhost:4321}"
API="$BASE/_emdash/api"
SERVER="${SERVER:-newsletter}"

cd "$(dirname "$0")/.."

if [[ "${1:-}" == "--disconnect" ]]; then
  claude mcp remove "$SERVER" --scope user >/dev/null 2>&1 || true
  echo "Disconnected Claude Code from the newsletter."
  exit 0
fi

command -v claude >/dev/null || { echo "Claude Code ('claude') isn't installed: https://claude.com/claude-code" >&2; exit 1; }
curl -sf -o /dev/null "$BASE/favicon.svg" || { echo "Nothing on $BASE. Start the server first: npm start" >&2; exit 1; }

# Read one field from JSON on stdin, e.g. json data.token. On failure it says
# which field was missing and never echoes the response, which can hold tokens.
json() { node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{let v;try{v=process.argv[1].split(".").reduce((o,k)=>o?.[k],JSON.parse(s))}catch{}if(v==null){console.error(`Unexpected response from the server (no ${process.argv[1]}).`);process.exit(1)}console.log(v)})' "$1"; }

admin_call() { # method path [json body]
  curl -sf -X "$1" "$API$2" -H "authorization: Bearer $ADMIN" -H "content-type: application/json" -H "x-emdash-request: 1" ${3:+-d "$3"}
}

if [[ -n "${ADMIN_TOKEN:-}" ]]; then
  ADMIN="$ADMIN_TOKEN"
else
  echo "1/4 Signing in with the dev sign-in (npm run dev only)"
  ADMIN=$(curl -sf "$API/setup/dev-bypass?token" | json data.token) || {
    echo "The dev sign-in isn't available: set ADMIN_TOKEN to an admin API token, or use the Settings page." >&2
    exit 1
  }
fi

# Approval covers the tools' exact definitions, so after an update that
# changes them they hide until this runs again.
echo "2/4 Approving the newsletter plugin's MCP tools"
admin_call PUT /admin/plugins/newsletter/mcp '{"enabled":true}' | json data.enabled >/dev/null

echo "3/4 Making a token for Claude"
TOKEN=$(admin_call POST /admin/api-tokens \
  '{"name":"claude-code","scopes":["content:read","content:write","media:read","media:write","mcp:tools:newsletter"]}' | json data.token)

echo "4/4 Adding '$SERVER' to Claude Code"
claude mcp remove "$SERVER" --scope user >/dev/null 2>&1 || true
claude mcp add --transport http --scope user "$SERVER" "$API/mcp" \
  --header "Authorization: Bearer $TOKEN" >/dev/null

cat <<EOF

Done. Start a new Claude Code session and try:
  "what's in the newsletter inbox?"
  "start the next edition of the newsletter"

Updated newsletteditor? Run this again to re-approve the tools.
EOF
