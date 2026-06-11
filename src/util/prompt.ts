import readline from "node:readline";

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

export function ask(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (a) => {
      rl.close();
      resolve(a.trim());
    });
  });
}

/** Yes/no prompt. In non-interactive contexts returns `def` without blocking. */
export async function confirm(question: string, def = true): Promise<boolean> {
  if (!interactive()) return def;
  const hint = def ? "[Y/n]" : "[y/N]";
  const a = (await ask(`${question} ${hint} `)).toLowerCase();
  if (!a) return def;
  return /^y/.test(a);
}

/** Single-choice menu. Returns the chosen item, or the first item when non-interactive. */
export async function select<T>(question: string, items: T[], render: (t: T) => string): Promise<T> {
  if (!interactive() || items.length <= 1) return items[0];
  console.log(question);
  items.forEach((it, i) => console.log(`  ${i + 1}) ${render(it)}`));
  const a = await ask(`Choose [1-${items.length}] (default 1): `);
  const n = parseInt(a, 10);
  return Number.isInteger(n) && n >= 1 && n <= items.length ? items[n - 1] : items[0];
}
