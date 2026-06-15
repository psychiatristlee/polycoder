#!/usr/bin/env bash
# poly subagent — one-shot installer for macOS / Linux GPU boxes.
# Turns this machine into an always-on remote LLM worker for your poly account:
#   1) ensures Node >= 22 and a global `poly`
#   2) `poly subagent serve --install` → installs Ollama, pulls the heaviest model that
#      fits this GPU, generates a relay token, and registers an autostart service.
# Run from inside the polycoder repo:  bash install/subagent-install.sh
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT"
say() { printf "\033[1m›\033[0m %s\n" "$1"; }
err() { printf "\033[31m✗ %s\033[0m\n" "$1" >&2; }

# --- 1) Node >= 22 ----------------------------------------------------------
need_node() {
  command -v node >/dev/null 2>&1 || return 1
  local major; major="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
  [ "${major:-0}" -ge 22 ]
}
if ! need_node; then
  say "Node >= 22 not found — attempting install…"
  if [ "$(uname)" = "Darwin" ] && command -v brew >/dev/null 2>&1; then
    brew install node
  elif command -v apt-get >/dev/null 2>&1; then
    curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash - && sudo apt-get install -y nodejs
  else
    err "Install Node >= 22 manually (https://nodejs.org) then re-run."; exit 1
  fi
fi
say "Node $(node -v)"

# --- 2) build + global install ----------------------------------------------
say "Installing dependencies…"; npm install --silent
say "Building…"; npm run build --silent
say "Installing 'poly' globally…"; npm install -g . --silent
command -v poly >/dev/null 2>&1 || { err "'poly' not on PATH after install. Check your npm global bin dir."; exit 1; }
say "poly $(poly --version 2>/dev/null || echo installed)"

# --- 3) (optional) OpenRouter key so the node binds to YOUR account ----------
if [ -n "${OPENROUTER_API_KEY:-}" ]; then
  poly config set apikey "$OPENROUTER_API_KEY" >/dev/null 2>&1 || true
  say "Stored OpenRouter key (account binding)."
else
  say "No OPENROUTER_API_KEY set — node will register under the anonymous account."
  say "  To bind it to your account first:  poly config set apikey sk-or-…"
fi

# --- 4) serve + autostart ----------------------------------------------------
TRANSPORT="${POLY_SUBAGENT_TRANSPORT:---tunnel}"  # --tunnel (default) or --lan
say "Setting up the subagent service ($TRANSPORT)…"
poly subagent serve -y --install $TRANSPORT

echo
say "Done. This machine is now a poly subagent."
say "On your laptop (same account):  poly subagent link"
say "Check status here any time:     poly subagent status"
