# poly subagent — install on a GPU machine

A **subagent** turns a spare GPU box into a private, always-on LLM worker for your poly
account. Your laptop (polyrun) runs the same account and calls the GPU machine's local
model over an authenticated tunnel — no inbound ports, no API bills for those calls.

## Quick install

Copy/clone this repo onto the GPU machine, then from the repo root:

**macOS / Linux**
```bash
# optional: bind this node to your account up front
export OPENROUTER_API_KEY=sk-or-...
bash install/subagent-install.sh
```

**Windows (PowerShell, as Administrator for the scheduled task)**
```powershell
$env:OPENROUTER_API_KEY = "sk-or-..."
powershell -ExecutionPolicy Bypass -File install\subagent-install.ps1
```

The installer:
1. ensures **Node ≥ 22** and installs `poly` globally,
2. runs `poly subagent serve --install`, which:
   - installs **Ollama** and pulls the **heaviest coding model that fits this GPU**
     (NVIDIA via `nvidia-smi`, Apple Silicon unified memory, AMD ROCm, else CPU),
   - starts an **auth-proxy** in front of Ollama (Ollama has no auth of its own — the
     proxy requires a per-node **relay token** and allowlists only inference routes),
   - exposes it via a **Cloudflare quick tunnel** (outbound-only) or `--lan`,
   - registers an **autostart service** (LaunchAgent on macOS, Scheduled Task on Windows)
     so it serves on every boot/login.

### Transport
- Default is `--tunnel` (works across networks/NAT, no port-forwarding).
- For a same-LAN setup: `POLY_SUBAGENT_TRANSPORT=--lan bash install/subagent-install.sh`.

## Use it from your laptop

Same OpenRouter key / account on the laptop, then:
```bash
poly subagent link            # auto-discovers the node via your account
poly subagent status          # shows the live endpoint + online nodes
poly subagent test            # authenticated round-trip
poly run --model local/<model> "build me X"   # route a task to the GPU box
```
If discovery is unavailable (no Firebase creds), paste the endpoint + token the GPU box
printed: `poly subagent link --url <url> --token <token>`.

## Manual (no installer)
```bash
npm install && npm run build && npm install -g .
poly subagent serve            # foreground (Ctrl+C to stop)
poly subagent serve --install  # set up the autostart service and exit
```

## Security notes
- The **relay token** is the security boundary. It's shown once on `serve`/`--install`;
  rotate with `poly subagent rotate`.
- The proxy only forwards `/v1/chat/completions`, `/v1/completions`, `/v1/models`,
  `/v1/embeddings`; everything else (including Ollama's admin API) returns 404. Repeated
  bad tokens from an IP get a short lockout.
- The OpenRouter key is **never** sent to the subagent — `local/*` calls carry the relay
  token instead.
