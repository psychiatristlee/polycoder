import pc from "picocolors";

/** Format a USD amount with sensible precision for tiny per-call costs. */
export function usd(amount: number): string {
  if (amount === 0) return "$0";
  if (amount < 0.0001) return "<$0.0001";
  if (amount < 1) return "$" + amount.toFixed(4);
  if (amount < 100) return "$" + amount.toFixed(3);
  return "$" + amount.toFixed(2);
}

/** Price per million tokens, e.g. "$0.25/M". */
export function perMTok(usdPerMTok: number): string {
  if (usdPerMTok === 0) return "free";
  if (usdPerMTok < 1) return "$" + usdPerMTok.toFixed(3) + "/M";
  return "$" + usdPerMTok.toFixed(2) + "/M";
}

export function tokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return (n / 1000).toFixed(1).replace(/\.0$/, "") + "k";
  return (n / 1_000_000).toFixed(2).replace(/\.00$/, "") + "M";
}

export function tierColor(tier: string, text?: string): string {
  const t = text ?? tier;
  switch (tier) {
    case "cheap":
      return pc.green(t);
    case "standard":
      return pc.yellow(t);
    case "frontier":
      return pc.magenta(t);
    default:
      return t;
  }
}

/** Render a simple fixed-width text table. */
export function table(headers: string[], rows: string[][]): string {
  const widths = headers.map((h, i) =>
    Math.max(visibleLen(h), ...rows.map((r) => visibleLen(r[i] ?? "")))
  );
  const sep = "  ";
  const fmtRow = (cells: string[]) =>
    cells.map((c, i) => pad(c, widths[i])).join(sep).trimEnd();
  const lines = [
    pc.bold(fmtRow(headers)),
    widths.map((w) => "─".repeat(w)).join(sep),
    ...rows.map(fmtRow),
  ];
  return lines.join("\n");
}

// picocolors wraps text in ANSI escapes; measure/pad by visible length.
const ANSI = /\x1b\[[0-9;]*m/g;
function visibleLen(s: string): number {
  return s.replace(ANSI, "").length;
}
function pad(s: string, width: number): string {
  const extra = width - visibleLen(s);
  return extra > 0 ? s + " ".repeat(extra) : s;
}

export const c = pc;
