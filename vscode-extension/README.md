# Polymath for VS Code

Run the [Polymath](https://github.com/psychiatristlee/polycoder) cost-optimized
multi-model coding agent from inside VS Code.

This extension is a thin launcher: it drives the `poly` CLI in an integrated
terminal, so the full TUI (plan preview, per-task model routing, live cost) runs
right in your editor against the open workspace.

## Requirements

- The Polymath CLI on your PATH: `npm install -g polycoder`
  (the extension offers to install it for you if it's missing).
- Node.js ≥ 22.5.

## Commands (Command Palette → "Polymath:")

| Command | Action |
|---|---|
| Polymath: Run agent | Prompt for a task and launch `poly run` in the workspace |
| Polymath: Recommend models for a task | Estimate best/value/quality model combos (uses your selection) |
| Polymath: Show usage & cost | `poly usage` |
| Polymath: Browse models | `poly models` |
| Polymath: Connect API key | `poly login` |

`Polymath: Recommend` is also available in the editor right-click menu when text
is selected.

## Settings

- `polymath.cliPath` — path to the `poly` executable (default `poly`).

## Build / package from source

```bash
cd vscode-extension
npm install
npm run build
npm run package   # produces polymath-vscode-0.1.0.vsix
```

Install the `.vsix` via **Extensions → … → Install from VSIX…**.
