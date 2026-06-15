// Cloudflare quick-tunnel: outbound-only HTTPS tunnel to the local auth-proxy, so the
// GPU box needs no inbound ports / NAT config. cloudflared is found on PATH or fetched
// per-OS into the config dir. Returns the public https://*.trycloudflare.com URL.
import { spawn, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { configDir, ensureConfigDir } from "../config/paths.js";

function binDir(): string {
  return path.join(configDir(), "bin");
}
function cloudflaredPath(): string {
  return path.join(binDir(), process.platform === "win32" ? "cloudflared.exe" : "cloudflared");
}

export function findCloudflared(): string | null {
  // PATH
  try {
    const which = process.platform === "win32" ? "where cloudflared" : "command -v cloudflared";
    const p = execSync(which, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim().split("\n")[0];
    if (p) return p;
  } catch {
    /* not on PATH */
  }
  const local = cloudflaredPath();
  return fs.existsSync(local) ? local : null;
}

function downloadUrl(): string | null {
  const base = "https://github.com/cloudflare/cloudflared/releases/latest/download/";
  const arch = os.arch(); // 'arm64' | 'x64'
  if (process.platform === "darwin") return base + (arch === "arm64" ? "cloudflared-darwin-arm64.tgz" : "cloudflared-darwin-amd64.tgz");
  if (process.platform === "linux") return base + (arch === "arm64" ? "cloudflared-linux-arm64" : "cloudflared-linux-amd64");
  if (process.platform === "win32") return base + "cloudflared-windows-amd64.exe";
  return null;
}

/** Best-effort fetch of cloudflared into the config dir. Returns the path or null. */
export async function ensureCloudflared(): Promise<string | null> {
  const found = findCloudflared();
  if (found) return found;
  const url = downloadUrl();
  if (!url) return null;
  ensureConfigDir();
  fs.mkdirSync(binDir(), { recursive: true });
  const dest = cloudflaredPath();
  try {
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return null;
    const buf = Buffer.from(await res.arrayBuffer());
    if (url.endsWith(".tgz")) {
      const tgz = path.join(binDir(), "cloudflared.tgz");
      fs.writeFileSync(tgz, buf);
      execSync(`tar xzf "${tgz}" -C "${binDir()}"`, { stdio: "ignore" });
      fs.rmSync(tgz, { force: true });
    } else {
      fs.writeFileSync(dest, buf);
    }
    if (process.platform !== "win32") fs.chmodSync(dest, 0o755);
    return fs.existsSync(dest) ? dest : findCloudflared();
  } catch {
    return null;
  }
}

export interface Tunnel {
  url: string;
  proc: import("node:child_process").ChildProcess;
}

/** Start a quick tunnel to http://127.0.0.1:<port> and resolve once the URL appears. */
export async function startTunnel(port: number): Promise<Tunnel | null> {
  const bin = await ensureCloudflared();
  if (!bin) return null;
  const proc = spawn(bin, ["tunnel", "--no-autoupdate", "--url", `http://127.0.0.1:${port}`], { stdio: ["ignore", "pipe", "pipe"] });
  return new Promise((resolve) => {
    let done = false;
    const onData = (d: Buffer) => {
      const m = d.toString().match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/);
      if (m && !done) {
        done = true;
        resolve({ url: m[0], proc });
      }
    };
    proc.stdout?.on("data", onData);
    proc.stderr?.on("data", onData);
    proc.on("error", () => !done && (done = true, resolve(null)));
    setTimeout(() => !done && (done = true, resolve(null)), 25_000);
  });
}
