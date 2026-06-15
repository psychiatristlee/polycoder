// Polymac — Electron main process. A Claude-Desktop-style app whose engine is the
// poly agent: it picks a working folder, accepts an OpenRouter key (or uses the local
// LLM), and drives `poly agent` (headless JSON stream) to edit files / write code.
const { app, BrowserWindow, ipcMain, dialog, shell } = require("electron");
const { spawn, execSync } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");

const IS_WIN = process.platform === "win32";
function polyBin() {
  try {
    const which = IS_WIN ? "where poly" : "command -v poly";
    return execSync(which, { encoding: "utf8" }).trim().split(/\r?\n/)[0] || "poly";
  } catch {
    return "poly";
  }
}
const POLY = polyBin();

// Spawn `poly <args>` cross-platform. On Windows `poly` is a `.cmd` shim that spawn() can
// only run through a shell, so we build a single quoted command line; on POSIX we pass the
// argv array directly (no shell) and detach so a Stop can kill the whole process group.
function winQuote(s) {
  s = String(s);
  return /[\s"&|<>^()]/.test(s) || s === "" ? '"' + s.replace(/"/g, '""') + '"' : s;
}
function spawnPoly(args, opts = {}) {
  if (IS_WIN) {
    const line = [POLY, ...args].map(winQuote).join(" ");
    return spawn(line, { shell: true, env: process.env, windowsHide: true, ...opts });
  }
  return spawn(POLY, args, { env: process.env, detached: !!opts.detached, windowsHide: true, ...opts });
}
function killChildTree(child) {
  if (!child || child.killed) return;
  try {
    if (IS_WIN) execSync(`taskkill /pid ${child.pid} /T /F`, { stdio: "ignore" });
    else process.kill(-child.pid, "SIGKILL");
  } catch {
    try {
      child.kill("SIGKILL");
    } catch {
      /* gone */
    }
  }
}
let win;
let agentChild = null;
let superviseChild = null;

// ---- attachments: images, video keyframes, and other documents -------------
const IMG_EXT = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "tiff", "heic", "svg"]);
const VID_EXT = new Set(["mp4", "mov", "m4v", "avi", "mkv", "webm", "wmv", "flv"]);
const TEXT_EXT = new Set(["txt", "md", "markdown", "csv", "tsv", "json", "yaml", "yml", "xml", "html", "css", "js", "ts", "tsx", "jsx", "py", "java", "c", "cpp", "h", "go", "rs", "rb", "php", "sh", "sql", "log", "ini", "toml", "env"]);
function extOf(p) {
  return (p.split(".").pop() || "").toLowerCase();
}
function fileKind(p) {
  const e = extOf(p);
  if (IMG_EXT.has(e)) return "image";
  if (VID_EXT.has(e)) return "video";
  if (e === "pdf" || e === "docx" || e === "xlsx" || e === "xls" || e === "pptx") return "doc";
  if (TEXT_EXT.has(e)) return "text";
  return "other";
}
function which(bin) {
  try {
    execSync((IS_WIN ? "where " : "command -v ") + bin, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}
function ffmpegBin() {
  if (which("ffmpeg")) return "ffmpeg";
  try {
    const p = require("ffmpeg-static");
    if (p && fs.existsSync(p)) return p;
  } catch {
    /* not installed */
  }
  return null;
}
// Extract up to `max` keyframes (scene changes) from a video into outDir; falls back to
// even time-sampling if scene detection yields too few. Returns absolute frame paths.
function extractKeyframes(video, outDir, max = 8) {
  const ff = ffmpegBin();
  if (!ff) return { ok: false, error: "ffmpeg not found (install ffmpeg, or `npm i ffmpeg-static` in desktop/)", frames: [] };
  const base = path.basename(video).replace(/\.[^.]+$/, "").replace(/[^\w.-]/g, "_");
  const pat = path.join(outDir, base + "_kf_%03d.png");
  const tryRun = (vf) => {
    try {
      execSync(`"${ff}" -y -i ${JSON.stringify(video)} -vf "${vf}" -vsync vfr -frames:v ${max} ${JSON.stringify(pat)}`, { stdio: "ignore" });
    } catch {
      /* may still have produced some frames */
    }
    return fs.readdirSync(outDir).filter((f) => f.startsWith(base + "_kf_")).sort().map((f) => path.join(outDir, f));
  };
  let frames = tryRun("select='gt(scene\\,0.3)',scale=640:-1");
  if (frames.length < 2) {
    frames.forEach((f) => { try { fs.rmSync(f); } catch {} });
    frames = tryRun("fps=1/2,scale=640:-1"); // 1 frame / 2s
  }
  return { ok: frames.length > 0, frames: frames.slice(0, max), error: frames.length ? "" : "no frames extracted" };
}
// Best-effort text extraction for documents the agent can't natively read.
function extractText(file) {
  const e = extOf(file);
  try {
    if (TEXT_EXT.has(e)) return fs.readFileSync(file, "utf8").slice(0, 8000);
    if (e === "xlsx" || e === "xls") {
      const XLSX = require("xlsx");
      const wb = XLSX.readFile(file);
      return wb.SheetNames.slice(0, 4).map((n) => `# ${n}\n` + XLSX.utils.sheet_to_csv(wb.Sheets[n]).slice(0, 3000)).join("\n\n");
    }
    if (e === "docx" || e === "pptx") {
      // OOXML is a zip of XML; pull the body text without extra deps.
      const part = e === "docx" ? "word/document.xml" : "ppt/slides/slide1.xml";
      const xml = execSync(`unzip -p ${JSON.stringify(file)} ${part}`, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
      return xml.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim().slice(0, 6000);
    }
    if (e === "pdf") {
      if (which("pdftotext")) return execSync(`pdftotext -l 5 ${JSON.stringify(file)} -`, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 }).slice(0, 6000);
      return "";
    }
  } catch {
    /* fall through */
  }
  return "";
}
// Describe images (and keyframes) with the poly vision model. Returns descriptions[].
function describeImages(paths) {
  if (!paths.length) return [];
  try {
    const args = ["vision", "describe", ...paths, "--json", "-q", "Describe this image: layout, visible text, colors, and notable objects."];
    const line = IS_WIN ? [POLY, ...args].map(winQuote).join(" ") : null;
    const out = IS_WIN
      ? execSync(line, { encoding: "utf8", maxBuffer: 16 * 1024 * 1024, shell: true })
      : execSync([POLY, ...args.map((a) => JSON.stringify(a))].join(" "), { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
    const parsed = JSON.parse(out.trim().split("\n").filter(Boolean).pop());
    const byFile = {};
    (parsed.results || []).forEach((r) => (byFile[r.file] = r.description));
    return paths.map((p) => byFile[p] || byFile[path.resolve(p)] || "(설명 없음)");
  } catch (err) {
    return paths.map(() => "(이미지 분석 실패: " + (err && err.message ? err.message.slice(0, 80) : "error") + ")");
  }
}
// Build an augmented goal: copy attachments into the project, extract keyframes/text,
// describe images, and append a structured [첨부] context block to the goal.
async function buildAugmentedGoal(goal, cwd, attachments, send) {
  if (!attachments || !attachments.length) return goal;
  const dir = path.join(cwd, ".polyrun-attachments");
  fs.mkdirSync(dir, { recursive: true });
  const lines = [];
  const imgs = []; // {path,label}
  for (const a of attachments) {
    const kind = a.kind || fileKind(a.path);
    if (kind === "video") {
      send("🎬 키프레임 추출 중: " + path.basename(a.path));
      const r = extractKeyframes(a.path, dir);
      if (!r.ok) { lines.push(`- ${path.basename(a.path)} (동영상): ${r.error}`); continue; }
      r.frames.forEach((f, i) => imgs.push({ path: f, label: path.basename(a.path) + " 키프레임 " + (i + 1) }));
    } else if (kind === "image") {
      const dest = path.join(dir, path.basename(a.path));
      try { fs.copyFileSync(a.path, dest); } catch {}
      imgs.push({ path: dest, label: path.basename(a.path) });
    } else {
      const dest = path.join(dir, path.basename(a.path));
      try { fs.copyFileSync(a.path, dest); } catch {}
      const text = extractText(dest);
      lines.push(`- ${path.basename(a.path)} (.polyrun-attachments/${path.basename(dest)})` + (text ? `:\n"""\n${text}\n"""` : " — 바이너리 파일, 경로 참조"));
    }
  }
  if (imgs.length) {
    send("🖼  이미지 분석 중 (vision) · " + imgs.length + "장…");
    const descs = describeImages(imgs.map((i) => i.path));
    imgs.forEach((im, i) => lines.push(`- ${im.label} (.polyrun-attachments/${path.basename(im.path)}): ${descs[i]}`));
  }
  if (!lines.length) return goal;
  return goal + "\n\n[첨부 파일 — 원본은 .polyrun-attachments/ 에 있음]\n" + lines.join("\n");
}

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
    if (process.env.POLY_AUTOCWD || process.env.POLY_AUTOGOAL || process.env.POLY_VIEW) {
      win.webContents.send("auto", {
        goal: process.env.POLY_AUTOGOAL || "",
        cwd: process.env.POLY_AUTOCWD || os.homedir(),
        shot: process.env.POLY_SHOT || "",
        run: !!process.env.POLY_AUTORUN,
        preview: process.env.POLY_PREVIEW || "",
        view: process.env.POLY_VIEW || "",
        sup: {
          agent: process.env.POLY_SUP_AGENT || "",
          cmd: process.env.POLY_SUP_CMD || "",
          auto: !!process.env.POLY_SUP_AUTO,
          max: process.env.POLY_SUP_MAX || "",
          model: process.env.POLY_SUP_MODEL || "",
          run: !!process.env.POLY_SUP_RUN,
        },
      });
    }
    // Capture-on-load (no chat agent) for deterministic screenshots. POLY_SHOT_DELAY lets
    // a supervision run finish before the shot.
    if (process.env.POLY_SHOT && !process.env.POLY_AUTORUN) {
      const delay = parseInt(process.env.POLY_SHOT_DELAY || "", 10) || 5500;
      setTimeout(async () => {
        try {
          const img = await win.webContents.capturePage();
          fs.writeFileSync(process.env.POLY_SHOT, img.toPNG());
        } catch {
          /* ignore */
        }
      }, delay);
    }
  });
}

function configStatus() {
  try {
    const p = path.join(os.homedir(), ".config", "polymath", "config.json");
    const c = JSON.parse(fs.readFileSync(p, "utf8"));
    return {
      hasKey: !!c.openrouterApiKey || !!process.env.OPENROUTER_API_KEY,
      local: !!(c.local && c.local.enabled),
      baseUrl: (c.local && c.local.baseUrl) || "http://localhost:11434/v1",
    };
  } catch {
    return { hasKey: !!process.env.OPENROUTER_API_KEY, local: false, baseUrl: "http://localhost:11434/v1" };
  }
}

ipcMain.handle("status", () => configStatus());
// Point poly at an OpenAI-compatible local runtime (Ollama / LM Studio / llama.cpp / …).
ipcMain.handle("set-local-url", (_e, url) =>
  new Promise((resolve) => {
    const u = String(url || "").trim();
    const args = u ? ["config", "local", "on", "--base", u] : ["config", "local", "off"];
    const child = spawnPoly(args);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  })
);
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
// Attachments: file picker → [{path,name,kind,thumb}], where thumb is a small data URL for images.
ipcMain.handle("pick-attachments", async () => {
  const r = await dialog.showOpenDialog(win, {
    properties: ["openFile", "multiSelections"],
    filters: [
      { name: "All supported", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "heic", "svg", "mp4", "mov", "m4v", "avi", "mkv", "webm", "pdf", "docx", "xlsx", "pptx", "txt", "md", "csv", "json"] },
      { name: "All files", extensions: ["*"] },
    ],
  });
  if (r.canceled) return [];
  return r.filePaths.map((p) => ({ path: p, name: path.basename(p), kind: fileKind(p), thumb: imageThumb(p) }));
});
function imageThumb(p) {
  try {
    if (fileKind(p) !== "image" || extOf(p) === "svg") return "";
    const st = fs.statSync(p);
    if (st.size > 4 * 1024 * 1024) return ""; // too big to inline; show an icon instead
    const mime = "image/" + (extOf(p) === "jpg" ? "jpeg" : extOf(p));
    return `data:${mime};base64,${fs.readFileSync(p).toString("base64")}`;
  } catch {
    return "";
  }
}
ipcMain.handle("attachment-kind", (_e, p) => fileKind(p));
// Run a poly subcommand that prints a JSON line; return the parsed object (or null).
function runPolyJson(args) {
  return new Promise((resolve) => {
    const child = spawnPoly(args);
    let out = "";
    child.stdout.on("data", (d) => (out += d.toString()));
    child.on("error", () => resolve(null));
    child.on("close", () => {
      try {
        const line = out.trim().split("\n").filter(Boolean).pop();
        resolve(JSON.parse(line));
      } catch {
        resolve(null);
      }
    });
  });
}
ipcMain.handle("local-catalog", () => runPolyJson(["local", "catalog", "--json"]));
ipcMain.handle("cloud-catalog", () => runPolyJson(["models", "--json"]));
ipcMain.handle("local-list", () => runPolyJson(["local", "list", "--json"]));
ipcMain.on("local-pull", (e, id) => {
  const child = spawnPoly(["local", "pull", id, "-y"]);
  let buf = "";
  const pump = (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const ln of lines) if (ln.trim()) e.sender.send("agent-log", ln);
  };
  child.stdout.on("data", pump);
  child.stderr.on("data", pump);
  child.on("close", (code) => {
    if (buf.trim()) e.sender.send("agent-log", buf);
    e.sender.send("agent-log", code === 0 ? "[모델 설치 완료: " + id + "]" : "[모델 설치 실패: " + id + "]");
    e.sender.send("local-pull-done", { id, ok: code === 0 });
  });
  child.on("error", (err) => {
    e.sender.send("agent-log", "[설치 오류] " + err.message);
    e.sender.send("local-pull-done", { id, ok: false });
  });
});
ipcMain.handle("local-rm", (_e, id) =>
  new Promise((resolve) => {
    const child = spawnPoly(["local", "rm", id]);
    child.on("close", (code) => resolve(code === 0));
    child.on("error", () => resolve(false));
  })
);
ipcMain.handle("open-external", (_e, url) => {
  try {
    if (/^https?:\/\//i.test(String(url))) shell.openExternal(String(url));
    return true;
  } catch {
    return false;
  }
});
// Persist a pasted/in-memory blob (e.g. a clipboard screenshot) to a temp file so it can
// be attached like any other file.
ipcMain.handle("save-blob", (_e, { name, dataUrl }) => {
  try {
    const m = /^data:([^;]+);base64,(.*)$/s.exec(dataUrl || "");
    if (!m) return null;
    const ext = (m[1].split("/")[1] || "png").replace("jpeg", "jpg").replace("svg+xml", "svg");
    const dir = path.join(os.tmpdir(), "polyrun-paste");
    fs.mkdirSync(dir, { recursive: true });
    const safe = (name && /\.[a-z0-9]+$/i.test(name) ? name : (name || "paste") + "." + ext).replace(/[^\w.-]/g, "_");
    const file = path.join(dir, Date.now() + "-" + safe);
    fs.writeFileSync(file, Buffer.from(m[2], "base64"));
    return { path: file, name: path.basename(file), kind: fileKind(file), thumb: imageThumb(file) };
  } catch {
    return null;
  }
});

ipcMain.on("run-agent", async (e, { goal, cwd, attachments }) => {
  try {
    fs.mkdirSync(cwd, { recursive: true });
  } catch {
    /* ignore */
  }
  let finalGoal = goal;
  if (attachments && attachments.length) {
    try {
      finalGoal = await buildAugmentedGoal(goal, cwd, attachments, (m) => e.sender.send("agent-log", m));
    } catch (err) {
      e.sender.send("agent-log", "[첨부 처리 오류] " + ((err && err.message) || err));
    }
  }
  const args = ["agent", finalGoal, "-w", "-x", "--web", "-C", cwd, "-o", process.env.POLY_OBJ || "value", "--no-free", "--no-skills"];
  const child = spawnPoly(args);
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
  const child = spawnPoly(["setup", "--auto", "-y"]);
  child.stdout.on("data", (d) => e.sender.send("agent-log", d.toString().trim()));
  child.stderr.on("data", (d) => e.sender.send("agent-log", d.toString().trim()));
  child.on("close", () => e.sender.send("agent-log", "[local LLM setup finished]"));
});

// ---- supervision mode: drive `poly supervise --json` and stream NDJSON events ----
ipcMain.on("supervise-run", (e, o) => {
  const args = ["supervise", o.cwd, "--json"];
  if (o.goal) args.push("-g", o.goal);
  if (o.cont) args.push("--continue");
  if (o.agent) args.push("--agent", o.agent);
  if (o.agent === "cmd" && o.cmd) args.push("--agent-cmd", o.cmd);
  if (o.auto) args.push("--auto", "-n", String(o.maxRuns || 5));
  if (o.model) args.push("-m", o.model);
  if (o.noFree !== false) args.push("--no-free");
  const child = spawnPoly(args, { detached: !IS_WIN });
  superviseChild = child;
  let buf = "";
  const emit = (ev) => {
    try {
      e.sender.send("supervise-event", ev);
    } catch {
      /* window gone */
    }
  };
  child.stdout.on("data", (d) => {
    buf += d.toString();
    const lines = buf.split("\n");
    buf = lines.pop();
    for (const ln of lines) {
      if (!ln.trim()) continue;
      try {
        emit(JSON.parse(ln));
      } catch {
        emit({ type: "log", line: ln });
      }
    }
  });
  child.stderr.on("data", (d) => emit({ type: "log", line: d.toString().trim() }));
  child.on("error", (err) => {
    emit({ type: "log", line: "[spawn error] " + err.message });
    emit({ type: "exit", code: null });
  });
  child.on("close", (code) => {
    superviseChild = null;
    emit({ type: "exit", code });
  });
});
ipcMain.on("supervise-stop", () => {
  killChildTree(superviseChild);
  superviseChild = null;
});

app.whenReady().then(createWindow);
app.on("activate", () => {
  if (BrowserWindow.getAllWindows().length === 0) createWindow();
});
app.on("window-all-closed", () => app.quit());
