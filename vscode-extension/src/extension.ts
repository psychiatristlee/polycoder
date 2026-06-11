import * as vscode from "vscode";
import { execSync } from "node:child_process";

function cli(): string {
  return vscode.workspace.getConfiguration("polymath").get<string>("cliPath", "poly");
}

function workspaceCwd(): string | undefined {
  return vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
}

let terminal: vscode.Terminal | undefined;
function term(): vscode.Terminal {
  if (!terminal || terminal.exitStatus !== undefined) {
    terminal = vscode.window.createTerminal({ name: "Polymath", cwd: workspaceCwd() });
  }
  terminal.show();
  return terminal;
}

// Single-quote for POSIX shells; harmless on the common case and avoids injection.
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

function isInstalled(): boolean {
  try {
    execSync(`${cli()} --version`, { stdio: "ignore", cwd: workspaceCwd() });
    return true;
  } catch {
    return false;
  }
}

async function ensureInstalled(): Promise<boolean> {
  if (isInstalled()) return true;
  const install = "Install globally";
  const setPath = "Set CLI path";
  const choice = await vscode.window.showWarningMessage(
    `Polymath CLI ("${cli()}") was not found on your PATH.`,
    install,
    setPath
  );
  if (choice === install) {
    const t = term();
    t.sendText("npm install -g polycoder");
    vscode.window.showInformationMessage(
      "Installing Polymath globally — re-run the command once npm finishes."
    );
  } else if (choice === setPath) {
    vscode.commands.executeCommand("workbench.action.openSettings", "polymath.cliPath");
  }
  return false;
}

function send(args: string) {
  term().sendText(`${cli()} ${args}`);
}

export function activate(ctx: vscode.ExtensionContext) {
  const register = (id: string, fn: () => void | Promise<void>) =>
    ctx.subscriptions.push(vscode.commands.registerCommand(id, fn));

  register("polymath.run", async () => {
    if (!(await ensureInstalled())) return;
    const goal = await vscode.window.showInputBox({
      prompt: "Polymath — what should it do?",
      placeHolder: "e.g. add a dark-mode toggle to the settings page",
    });
    send(goal && goal.trim() ? `run ${shellQuote(goal.trim())}` : "run");
  });

  register("polymath.recommend", async () => {
    if (!(await ensureInstalled())) return;
    const editor = vscode.window.activeTextEditor;
    const sel = editor ? editor.document.getText(editor.selection) : "";
    const goal = await vscode.window.showInputBox({
      prompt: "Polymath — task to estimate (best/value/quality model combos)",
      value: sel.slice(0, 200),
    });
    if (goal && goal.trim()) send(`recommend ${shellQuote(goal.trim())}`);
  });

  register("polymath.usage", async () => {
    if (await ensureInstalled()) send("usage");
  });
  register("polymath.models", async () => {
    if (await ensureInstalled()) send("models");
  });
  register("polymath.login", async () => {
    if (await ensureInstalled()) send("login");
  });
}

export function deactivate() {}
