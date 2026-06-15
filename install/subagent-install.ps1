# poly subagent — one-shot installer for Windows GPU boxes (PowerShell).
# Turns this machine into an always-on remote LLM worker for your poly account:
#   1) ensures Node >= 22 (via winget) and a global `poly`
#   2) `poly subagent serve --install` → installs Ollama, pulls the heaviest model that
#      fits this GPU (nvidia-smi), generates a relay token, registers a Scheduled Task.
# Run from inside the polycoder repo (PowerShell):
#   powershell -ExecutionPolicy Bypass -File install\subagent-install.ps1
$ErrorActionPreference = "Stop"
function Say($m) { Write-Host "› $m" -ForegroundColor Cyan }
function Fail($m) { Write-Host "✗ $m" -ForegroundColor Red; exit 1 }

$RepoRoot = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
Set-Location $RepoRoot

# --- 1) Node >= 22 ----------------------------------------------------------
function Test-Node {
  try {
    $major = (node -p "process.versions.node.split('.')[0]") 2>$null
    return [int]$major -ge 22
  } catch { return $false }
}
if (-not (Test-Node)) {
  Say "Node >= 22 not found — installing via winget…"
  if (Get-Command winget -ErrorAction SilentlyContinue) {
    winget install -e --id OpenJS.NodeJS.LTS --accept-source-agreements --accept-package-agreements
    $env:Path = [System.Environment]::GetEnvironmentVariable("Path","Machine") + ";" + [System.Environment]::GetEnvironmentVariable("Path","User")
  } else {
    Fail "Install Node >= 22 manually (https://nodejs.org) then re-run."
  }
}
if (-not (Test-Node)) { Fail "Node >= 22 still not detected. Open a new shell and re-run." }
Say ("Node " + (node -v))

# --- 2) build + global install ----------------------------------------------
Say "Installing dependencies…"; npm install --silent
Say "Building…"; npm run build --silent
Say "Installing 'poly' globally…"; npm install -g . --silent
if (-not (Get-Command poly -ErrorAction SilentlyContinue)) {
  # npm global bin may not be on PATH in this session — add it.
  $npmBin = (npm prefix -g)
  $env:Path += ";$npmBin"
}
if (-not (Get-Command poly -ErrorAction SilentlyContinue)) { Fail "'poly' not on PATH after install. Open a new shell and re-run." }
Say ("poly " + (poly --version))

# --- 3) (optional) OpenRouter key so the node binds to YOUR account ----------
if ($env:OPENROUTER_API_KEY) {
  poly config set apikey $env:OPENROUTER_API_KEY | Out-Null
  Say "Stored OpenRouter key (account binding)."
} else {
  Say "No OPENROUTER_API_KEY set — node registers under the anonymous account."
  Say "  To bind it first:  poly config set apikey sk-or-…"
}

# --- 4) serve + autostart ----------------------------------------------------
$Transport = if ($env:POLY_SUBAGENT_TRANSPORT) { $env:POLY_SUBAGENT_TRANSPORT } else { "--tunnel" }
Say "Setting up the subagent service ($Transport)…"
poly subagent serve -y --install $Transport

Write-Host ""
Say "Done. This machine is now a poly subagent."
Say "On your laptop (same account):  poly subagent link"
Say "Check status here any time:     poly subagent status"
