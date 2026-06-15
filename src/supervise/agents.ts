// Adapters for the external coding agents poly SUPERVISES. poly itself doesn't edit the
// project in supervision mode — it drives another agent (Claude Code / Codex CLI / any
// command), reads the diff that agent produced, and decides the next instruction.
//
// Each adapter knows how to launch its agent NON-INTERACTIVELY (headless, auto-approve
// edits) so the supervision loop never blocks on a TTY prompt. The prompt is delivered
// via argv or stdin (never shell-interpolated) so quoting/escaping can't break it.
import { spawn, execSync } from "node:child_process";

export type AgentKind = "claude" | "codex" | "cmd";

export interface LaunchSpec {
  argv: string[]; // executed without a shell (execFile-style) unless `shell` is set
  stdin?: string; // prompt piped to stdin (used when the agent reads the prompt there)
  shell?: boolean; // run argv[0] as a shell command line (only for the `cmd` adapter)
}

export interface AgentAdapter {
  kind: AgentKind;
  label: string;
  /** Whether the agent's binary is on PATH (always true for `cmd`). */
  available: boolean;
  bin: string;
  build(prompt: string): LaunchSpec;
}

function onPath(bin: string): boolean {
  try {
    const which = process.platform === "win32" ? `where ${bin}` : `command -v ${bin}`;
    execSync(which, { stdio: ["ignore", "pipe", "ignore"] });
    return true;
  } catch {
    return false;
  }
}

/**
 * Resolve an adapter. `cmd` takes a shell template: `{prompt}` is replaced with the
 * (shell-quoted) instruction, or — if the template has no placeholder — the prompt is
 * piped to the command's stdin.
 */
export function getAdapter(kind: AgentKind, cmdTemplate?: string): AgentAdapter {
  if (kind === "claude") {
    return {
      kind,
      label: "Claude Code",
      bin: "claude",
      available: onPath("claude"),
      // `-p` = headless print mode; acceptEdits applies file edits without a prompt.
      // The instruction is piped to stdin so it needs no shell quoting.
      build: (prompt) => ({ argv: ["claude", "-p", "--permission-mode", "acceptEdits"], stdin: prompt }),
    };
  }
  if (kind === "codex") {
    return {
      kind,
      label: "Codex CLI",
      bin: "codex",
      available: onPath("codex"),
      // `exec` = non-interactive; full-auto lets it edit within the workspace unattended.
      build: (prompt) => ({ argv: ["codex", "exec", "--full-auto", prompt] }),
    };
  }
  // Generic command adapter (also how tests inject a deterministic fake agent).
  const tpl = cmdTemplate || "";
  return {
    kind: "cmd",
    label: tpl ? `cmd: ${tpl.length > 40 ? tpl.slice(0, 40) + "…" : tpl}` : "cmd (none set)",
    bin: tpl.split(/\s+/)[0] || "",
    available: !!tpl,
    build: (prompt) => {
      if (tpl.includes("{prompt}")) {
        return { argv: [tpl.replace(/\{prompt\}/g, shellQuote(prompt))], shell: true };
      }
      return { argv: [tpl], shell: true, stdin: prompt };
    },
  };
}

function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

// Build a single shell command line from an argv. For the `cmd` adapter argv[0] is already
// a shell string (return as-is). Otherwise (claude/codex forced through a shell on Windows)
// quote each token for the host shell.
function quoteArgvForShell(argv: string[], alreadyShell: boolean): string {
  if (alreadyShell) return argv[0];
  if (process.platform === "win32") {
    return argv.map((s) => (/[\s"&|<>^%]/.test(s) || s === "" ? `"${s.replace(/"/g, '""')}"` : s)).join(" ");
  }
  return argv.map((s) => (/^[A-Za-z0-9_\/.:=@-]+$/.test(s) ? s : shellQuote(s))).join(" ");
}

export interface RunResult {
  code: number | null;
  output: string; // combined stdout+stderr, capped
  killed: boolean;
  killReason?: string;
  ms: number;
}

/**
 * Run an external agent to completion with an idle timeout (kills a hung/interactive
 * agent) and an absolute cap (stops a runaway). Mirrors the agent tool's command runner.
 */
export function runAgentProcess(
  spec: LaunchSpec,
  opts: { cwd: string; idleMs?: number; maxMs?: number; onChunk?: (s: string) => void; startedAt?: number }
): Promise<RunResult> {
  const idleMs = opts.idleMs ?? 180_000; // 3 min of silence → assume stuck
  const maxMs = opts.maxMs ?? 900_000; // 15 min hard cap per run
  const started = opts.startedAt ?? nowMs();
  const isWin = process.platform === "win32";
  return new Promise((resolve) => {
    // On Windows, agents are installed as `.cmd`/`.bat` shims that spawn() can only run
    // through a shell (shell:false won't resolve PATHEXT). So shell on win32 OR when the
    // `cmd` adapter already requested it. detached only helps process-group kill on POSIX.
    const useShell = isWin || !!spec.shell;
    const cmd = useShell ? quoteArgvForShell(spec.argv, !!spec.shell) : spec.argv[0];
    const cmdArgs = useShell ? [] : spec.argv.slice(1);
    const child = spawn(cmd, cmdArgs, {
      cwd: opts.cwd,
      shell: useShell,
      stdio: ["pipe", "pipe", "pipe"],
      detached: !isWin, // POSIX: own process group so we can kill the whole tree
      env: { ...process.env, CI: "1", GIT_PAGER: "cat", PAGER: "cat", npm_config_yes: "true" },
    });
    let out = "";
    let killed = false;
    let killReason = "";
    const CAP = 200_000;
    let idleTimer: ReturnType<typeof setTimeout> | undefined;
    let maxTimer: ReturnType<typeof setTimeout> | undefined;
    const clear = () => {
      if (idleTimer) clearTimeout(idleTimer);
      if (maxTimer) clearTimeout(maxTimer);
    };
    const killTree = (reason: string) => {
      killed = true;
      killReason = reason;
      const pid = child.pid as number;
      if (isWin) {
        // SIGKILL to a shell child doesn't reap its descendants on Windows; taskkill /T does.
        try {
          execSync(`taskkill /pid ${pid} /T /F`, { stdio: "ignore" });
        } catch {
          try {
            child.kill();
          } catch {
            /* already gone */
          }
        }
        return;
      }
      try {
        process.kill(-pid, "SIGKILL"); // negative pid → whole process group (POSIX)
      } catch {
        try {
          child.kill("SIGKILL");
        } catch {
          /* already gone */
        }
      }
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => killTree(`no output for ${Math.round(idleMs / 1000)}s (stuck/interactive)`), idleMs);
    };
    maxTimer = setTimeout(() => killTree(`exceeded ${Math.round(maxMs / 1000)}s hard cap`), maxMs);
    bumpIdle();
    const onData = (b: Buffer) => {
      const s = b.toString();
      if (out.length < CAP) out += s;
      opts.onChunk?.(s);
      bumpIdle();
    };
    child.stdout?.on("data", onData);
    child.stderr?.on("data", onData);
    if (spec.stdin != null) {
      child.stdin?.write(spec.stdin);
      child.stdin?.end();
    } else {
      child.stdin?.end();
    }
    child.on("error", (e) => {
      clear();
      resolve({ code: null, output: out + `\n[spawn error] ${e.message}`, killed: true, killReason: e.message, ms: nowMs() - started });
    });
    child.on("close", (code) => {
      clear();
      resolve({
        code,
        output: out.slice(0, CAP) + (killed ? `\n[killed: ${killReason}]` : ""),
        killed,
        killReason: killed ? killReason : undefined,
        ms: nowMs() - started,
      });
    });
  });
}

function nowMs(): number {
  return Number(process.hrtime.bigint() / 1_000_000n);
}
