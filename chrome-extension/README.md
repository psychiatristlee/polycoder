# Polymath for Chrome

A multi-model **browser-automation agent** in a side panel. Give it a goal for the
current tab — it reads the page, clicks, types, extracts, and navigates — routing
each model call to the most cost-effective tool-capable model and tracking cost by
date + model (in `chrome.storage`). Shares the same routing brain as the CLI.

## Install (load unpacked)

```bash
cd chrome-extension
npm install
npm run build          # produces dist/{background,sidepanel,options}.js
```

Then in Chrome:

1. Open `chrome://extensions`, enable **Developer mode** (top-right).
2. **Load unpacked** → select the `chrome-extension/` folder.
3. Click the Polymath toolbar icon to open the side panel.
4. Open **Settings** (the "Connect a key" link, or the extension's options page) and
   paste your [OpenRouter key](https://openrouter.ai/keys).

## Use

- Type a goal for the active tab (e.g. *"summarize this article and list the key points"*).
- **Recommend** shows the cheapest / value / quality model picks + an estimated
  session cost before you run.
- Pick a routing objective (top-right), then **Run**. Watch the agent act, with live
  cost in the header.
- **Usage** shows your spend grouped by date + model.

## Permissions & safety

- `scripting` + `<all_urls>` let the agent read and act on the page you point it at.
  It only touches the **active tab** and won't run on `chrome://` pages.
- Your API key is stored in `chrome.storage.local` (this browser only).
- This is an MVP: it automates same-tab actions and basic navigation well; complex
  multi-tab flows and login-gated sites may need supervision.
