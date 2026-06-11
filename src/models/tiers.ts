import type { Tier } from "../providers/types.js";

// Families we consider "frontier" by reputation, independent of price.
const FRONTIER_PATTERNS = [
  /claude.*(sonnet|opus)/,
  /\bgpt-4o\b(?!-mini)/,
  /\bgpt-4\.1\b(?!-mini|-nano)/,
  /\bgpt-5\b/,
  /\bo[1-4]\b/, // o1 / o3 / o4 reasoning models
  /gemini-(1\.5|2\.0|2\.5)-pro/,
  /grok-[2-9]/,
  /deepseek.*(r1|reasoner)/,
  /llama-3\.1-405b/,
  /llama-4-(maverick|behemoth)/,
  /qwen.*(max|235b|plus)/,
  /mistral-large/,
  /command-(r-plus|a)\b/,
];

// Families that are explicitly small/fast — bias toward cheap.
const SMALL_PATTERNS = [
  /mini/, /flash/, /haiku/, /lite/, /nano/, /small/,
  /-(1|2|3|7|8|9)b\b/, /\b(1|2|3|7|8|9)b-/,
];

/**
 * "Theoretical" capability tier from model family + price. Heuristic by design —
 * the user explicitly wants a theoretical cheapest-capable mapping, and this is
 * cheap to adjust. completionPerMTok is USD per million completion tokens.
 */
export function classifyTier(idOrName: string, completionPerMTok: number): Tier {
  const s = idOrName.toLowerCase();
  const isFrontierFamily = FRONTIER_PATTERNS.some((re) => re.test(s));
  const isSmallFamily = SMALL_PATTERNS.some((re) => re.test(s));

  if (isFrontierFamily && !isSmallFamily) return "frontier";

  // Price-based fallbacks (output price is the better quality proxy).
  if (!isSmallFamily && completionPerMTok >= 9) return "frontier";
  if (completionPerMTok <= 1.5 || isSmallFamily) {
    // Small + pricey (rare) still counts as standard.
    return completionPerMTok > 6 ? "standard" : "cheap";
  }
  return "standard";
}
