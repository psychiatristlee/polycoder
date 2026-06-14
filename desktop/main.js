// Polymac — Electron main process. A Claude-Desktop-style app whose engine is the
// poly agent: it picks a working folder, accepts an OpenRouter key (or uses the local
// LLM), and drives `poly agent` (headless JSON stream) to edit files / write code.
const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

function polyBin() {
  try {
    return execSync("command -v poly", { encoding: "utf8" }).trim() || "poly";
  } catch {
    return "poly";
  }
}
const POLY = polyBin();
let win;
let agentChild = null;

function createWindow() {
  win = new BrowserWindow({
    width: 1100,
    height: 800,
    title: "polyrun",
    backgroundColor: "#f7f2ea",
    webPreferences: { preload: path.join(__dirname, "preload.js") },
  });
  win.loadFile(path.join(__dirname, "renderer.html"));
  win.webContents.on("did-finish-load", () => {
    if (process.env.POLY_AUTOCWD || process.env.POLY_AUTOGOAL) {
      win.webContents.send("auto", {
        goal: process.env.POLY_AUTOGOAL || "",
        cwd: process.env.POLY_AUTOCWD || os.homedir(),
        shot: process.env.POLY_SHOT || "",
        run: !!process.env.POLY_AUTORUN,
        preview: process.env.POLY_PREVIEW || "",
      });
    }
    // Capture-on-load (no agent) for deterministic screenshots.
    if (process.env.POLY_SHOT && !process.env.POLY_AUTORUN) {
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.POLY_SHOT, img.toPNG());
        } catch {
          /* ignore */
        }
      }, 5500);
    }
  });
}

function configStatus() {
  try {
    const p = path.join(os.homedir(), ".config", "polymath", "config.json");
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    return { hasKey: !!c.openrouterApiKey || !!process.env.OPENROUTER_API_KEY, local: !!(c.local && c.local.enabled) };
  } catch {
    return { hasKey: !!process.env.OPENROUTER_API_KEY, local: false };
  }
}

ipcMain.handle("status", () => configStatus());
ipcMain.handle("pick-folder", async () => {
  const r = await dialog.showOpenDialog(win, { properties: ["openDirectory", "createDirectory"] });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle("save-key", (_e, key) => {
  try {
    execSync(`"${POLY}" config set apikey "${String(key).replace(/["$`\\]/g, "")}"`, { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
});
ipcMain.handle("list-files", (_e, dir) => {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).map((d) => (d.isDirectory() ? d.name + "/" : d.name)).sort().slice(0, 200);
  } catch {
    return [];
  }
});
ipcMain.handle("read-file", (_e, file) => {
  try {
    return { ok: true, content: fs.readFileSync(file, "utf8"), path: file };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e), path: file };
  }
});
ipcMain.handle("read-xlsx", (_e, file) => {
  try {
    const XLSX = require("xlsx");
    const wb = XLSX.readFile(file);
    const sheets = wb.SheetNames.slice(0, 6).map((name) => ({
      name,
      rows: XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: "" }).slice(0, 200),
    }));
    return { ok: true, sheets };
  } catch (e) {
    return { ok: false, error: String((e && e.message) || e) };
  }
});
ipcMain.handle("capture", async (_e, file) => {
  try {
    const img = await win.webContents.capturePage();
    fs.writeFileSync(file || path.join(os.tmpdir(), "polymac.png"), img.toPNG());
    return true;
  } catch {
    return false;
  }
});

ipcMain.on("run-agent", (e, { goal, cwd }) => {
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    /* ignore */
  }
  const args = ["agent", goal, "-w", "-x", "--web", "-C", cwd, "-o", process.env.POLY_OBJ || "value", "--no-free", "--no-skills"];
  const child = spawn(POLY, args, { env: process.env });
  agentChild = child;
  let buf = "";
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        e.sender.send("agent-event", JSON.parse(ln));
      } catch {
        e.sender.send("agent-log", ln);
      }
    }
  });
  child.stderr.on("data", (d) => e.sender.send("agent-log", d.toString().trim()));
  child.on("close", (code) => e.sender.send("agent-event", { type: "exit", code }));
});

ipcMain.on("answer", (_e, text) => {
  try {
    if (agentChild && agentChild.stdin && agentChild.stdin.writable) agentChild.stdin.write(String(text) + "\n");
  } catch {
    /* ignore */
  }
});

ipcMain.on("setup-local", (e) => {
  const child = spawn(POLY, ["setup", "--auto", "-y"], { env: process.env });
  child.stdout.on("data", (d) => e.sender.send("agent-log", d.toString().trim()));
  child.stderr.on("data", (d) => e.sender.send("agent-log", d.toString().trim()));
  child.on("close", () => e.sender.send("agent-log", "[local LLM setup finished]"));
});

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => app.quit());
