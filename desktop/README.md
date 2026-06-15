# polyrun — desktop app (macOS · Windows · Linux)

A Claude-Desktop-style app whose engine is the **poly** agent. Open a working folder and
ask in natural language; poly reads/writes files, runs commands, renders artifacts
(SVG/PDF/HTML/Markdown/CSV/JSON/XLSX + math), and includes **Supervision mode** — drive an
external coding agent (Claude Code / Codex) and let poly steer it.

## Attachments (chat input)
The composer accepts **images, video, and documents** via the 📎 button, drag-and-drop, or
paste. On send, poly:
- **Images** → described by a vision model (`poly vision describe`) and referenced in the prompt.
- **Video** → keyframes extracted (ffmpeg scene-detection, fps fallback) → each described like an image.
- **Documents** (pdf/docx/pptx/xlsx/csv/txt/code…) → text extracted and included as context.
Originals are copied into `<project>/.polyrun-attachments/` so the agent can open them too.
Video keyframes need `ffmpeg` on PATH (or `npm i ffmpeg-static` in `desktop/`); PDF text needs
`pdftotext` (poppler); docx/pptx need `unzip`.

## Requirements
- **`poly` on PATH.** The app spawns the global `poly` CLI. Install it from the repo root:
  `npm install && npm run build && npm install -g .` (or use `install/subagent-install.*`).
- Node ≥ 22 (for the CLI). The desktop shell itself bundles Electron.

## Run from source
```bash
cd desktop
npm install
npm start
```

## Build installers
```bash
cd desktop
npm install
npm run dist:win    # Windows  → dist/polyrun-Setup-<ver>.exe (NSIS)
npm run dist:mac    # macOS    → dist/polyrun-<ver>.dmg + .zip
npm run dist:all    # both (macOS host can cross-build the Windows NSIS via wine)
```
Output lands in `desktop/dist/`. The Windows installer is a user-level NSIS installer
(`oneClick:false`, choose install dir). It does **not** bundle the `poly` CLI — install
that separately (see Requirements) so the app can find it on PATH.

## Cross-platform notes
- On Windows the app runs the `poly.cmd` shim through a shell with quoted args; on
  macOS/Linux it execs the `poly` bin directly (detached, so Stop kills the whole tree).
- Supervision "Stop" uses `taskkill /T` on Windows and a process-group `SIGKILL` on POSIX.
