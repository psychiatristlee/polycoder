// Best-effort renderer for the quality stage: if the workspace is a runnable web app,
// boot its dev server, screenshot the page with headless Chrome, then tear the server
// down. Everything is guarded — on any failure it returns null and the judge falls back
// to a file-only score. No installs happen here (too slow); node_modules must exist.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

/** Locate a Chrome/Chromium binary for headless screenshots, or null. */
export function findChrome(): string | null {
  const apps = [
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/Applications/Chromium.app/Contents/MacOS/Chromium",
    "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  ];
  for (const a of apps) if (fs.existsSync(a)) return a;
  for (const bin of ["google-chrome", "chromium", "chromium-browser", "chrome", "microsoft-edge"]) {
    try {
      const p = execSync(`command -v ${bin}`, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      if (p) return p;
    } catch {
      /* not found */
    }
  }
  return null;
}

const WEB_DEPS = ["next", "react", "react-dom", "vite", "svelte", "vue", "astro", "@angular/core", "solid-js"];

/** A runnable web app = package.json with a web framework + a dev/start script + installed deps. */
export function detectWebApp(cwd: string): { script: string } | null {
  const pkgPath = path.join(cwd, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  let pkg: any;
  try {
    pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  } catch {
    return null;
  }
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  if (!WEB_DEPS.some((d) => deps[d])) return null;
  if (!fs.existsSync(path.join(cwd, "node_modules"))) return null; // don't install here
  const scripts = pkg.scripts ?? {};
  if (scripts.dev) return { script: "dev" };
  if (scripts.start) return { script: "start" };
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function ping(url: string): Promise<boolean> {
  try {
    const c = new AbortController();
    const t = setTimeout(() => c.abort(), 2000);
    const r = await fetch(url, { signal: c.signal });
    clearTimeout(t);
    return r.status < 500;
  } catch {
    return false;
  }
}

export interface RenderResult {
  screenshotPath: string;
  url: string;
}

/**
 * Boot the app's dev server on a random high port, wait until it serves, screenshot it,
 * then kill the server's whole process group. Returns null if anything fails.
 */
export async function renderScreenshot(
  cwd: string,
  opts: { port?: number; width?: number; height?: number } = {}
): Promise<RenderResult | null> {
  const chrome = findChrome();
  if (!chrome) return null;
  const app = detectWebApp(cwd);
  if (!app) return null;

  const port = opts.port ?? 30000 + Math.floor(Math.random() * 9000);
  const url = `http://localhost:${port}`;
  const child = spawn("npm", ["run", app.script], {
    cwd,
    env: { ...process.env, PORT: String(port), BROWSER: "none", CI: "1", NEXT_TELEMETRY_DISABLED: "1" },
    stdio: "ignore",
    detached: true,
  });
  const killTree = () => {
    try {
      process.kill(-(child.pid as number), "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        /* gone */
      }
    }
  };
  try {
    let ready = false;
    for (let i = 0; i < 45; i++) {
      if (await ping(url)) {
        ready = true;
        break;
      }
      await delay(1000);
    }
    if (!ready) return null;
    await delay(1800); // let it compile + paint
    const out = path.join(os.tmpdir(), `poly-quality-${port}.png`);
    execSync(
      `"${chrome}" --headless=new --disable-gpu --hide-scrollbars --force-device-scale-factor=1 ` +
        `--window-size=${opts.width ?? 1280},${opts.height ?? 2000} --screenshot="${out}" "${url}"`,
      { timeout: 60_000, stdio: "ignore" }
    );
    return fs.existsSync(out) ? { screenshotPath: out, url } : null;
  } catch {
    return null;
  } finally {
    killTree();
  }
}

/** Read a PNG into a data: URL for multimodal model input. */
export function pngDataUrl(file: string): string | null {
  try {
    const b64 = fs.readFileSync(file).toString("base64");
    return `data:image/png;base64,${b64}`;
  } catch {
    return null;
  }
}
