/**
 * Quality-score model keys (ROUTING_QUALITY_FIRST, pure, DB-free).
 *
 * The quality feed (src/lib/qualityScoreSync.ts) stores one row per leaderboard model under a
 * normalised KEY; the ranker looks a candidate up by the same normalisation of its provider model
 * id. Both sides use only string shape, never a provider, vendor or model-family table, so every
 * provider is mapped by the same rule:
 *
 *   slug      lower-case; every run of characters other than [a-z0-9] becomes one "-"
 *             ("Claude Opus 4.7" and "claude-opus-4-7" -> "claude-opus-4-7";
 *              "Gemini 2.5 Flash" and "gemini-2.5-flash" -> "gemini-2-5-flash")
 *   canonical the slug with trailing variant words removed, repeatedly: reasoning effort
 *             (low/medium/high/xhigh/max/ultra/minimal/none), thinking modes, speed modes
 *             (fast, fast-mode), release status (preview/latest/exp), quantisation tags
 *             (q8-0, fp8, bf16, nvfp4, ...), context sizes (32k) and 8-digit or ISO dates.
 *             "gpt-5.6-sol-high" -> "gpt-5-6-sol"; "gemini-3-flash-preview" -> "gemini-3-flash".
 *
 * On the leaderboard side only release-status words and dates are stripped from the name (effort
 * variants are in the parenthetical there, and "Qwen3.8-Max" is a model, not an effort); provider
 * ids get the full strip, after their exact key was tried.
 *
 * Variant words are removed only from the END, and words that name a different model
 * ("lite", "mini", "flash", "pro", "chat", sizes such as "27b") are never removed, so
 * "gemini-2.5-flash-lite" never maps to "gemini-2.5-flash".
 */

/** Release-status words: stripped from both leaderboard names and provider ids. */
const STATUS_WORDS = new Set(["preview", "latest", "exp", "experimental"]);

/**
 * Trailing words that describe how a model is run, not which model it is. Stripped from provider
 * ids only: on the leaderboard these appear inside the parenthetical variant, never in the name
 * ("Qwen3.8-Max" is a model; "GPT-6 Sol (Max)" is a variant), and exact keys are tried first.
 */
const VARIANT_WORDS = new Set([
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
  "ultra",
  "minimal",
  "none",
  "thinking",
  "non-thinking",
  "nonthinking",
  "reasoning-off",
  "fast",
  "fast-mode",
  "mode",
  ...STATUS_WORDS,
  "bf16",
  "fp16",
  "fp8",
  "fp4",
  "nvfp4",
  "mxfp4",
  "int4",
  "int8",
  "awq",
  "gptq",
  "gguf",
  "mlx",
]);

/** q8-0, q4-k-m, q5-1 ... (ollama quantisation tags after slugging). */
const QUANT_TAIL = /-(?:q\d(?:-k)?(?:-[a-z0-9])?(?:-[a-z0-9])?|iq\d(?:-[a-z0-9]+)?)$/;
/** 32k, 16k ... (thinking-budget sizes inside a leaderboard variant). */
const CONTEXT_TAIL = /-\d{1,4}k$/;
/** -20251001 (8-digit snapshot) or -2024-11-20 (ISO date, slugged). */
const DATE_TAIL = /-(?:\d{8}|\d{4}-\d{2}-\d{2})$/;
const EIGHT_DIGIT_DATE = /^\d{8}$/;

export function slugModelName(value: string): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Remove trailing variant words, quantisation tags, context sizes and dates from a slug. With
 * `statusOnly` (leaderboard names) only release-status words and dates are removed.
 */
export function canonicalQualityKey(slug: string, statusOnly = false): string {
  let key = slugModelName(slug);
  const words = statusOnly ? STATUS_WORDS : VARIANT_WORDS;
  for (let guard = 0; guard < 12; guard++) {
    const before = key;
    key = key.replace(DATE_TAIL, "");
    if (!statusOnly) key = key.replace(QUANT_TAIL, "").replace(CONTEXT_TAIL, "");
    for (const word of words) {
      if (key.endsWith(`-${word}`) && key.length > word.length + 1) {
        key = key.slice(0, -(word.length + 1));
        break;
      }
    }
    if (key === before) break;
  }
  return key;
}

export interface LeaderboardRowKeys {
  /** The full display name, variant included ("GPT-5.6 Sol (xHigh)" -> "gpt-5-6-sol-xhigh"). */
  exact: string;
  /** The model without any variant ("gpt-5-6-sol"). */
  canonical: string;
  /** canonical + 8-digit date when the variant names one ("claude-haiku-4-5-20251001"). */
  dated: string | null;
  /** True when the row names the plain model: its parenthetical holds nothing but a date. */
  plain: boolean;
  /** Extra keys without a leading organisation word ("nvidia-nemotron-x" -> "nemotron-x"). */
  withoutOrganization: string[];
}

/**
 * Keys under which one leaderboard row is stored. `organization` is the row's own organisation
 * field; a display name that starts with it ("NVIDIA-Nemotron-...", organisation "nvidia") is also
 * stored without it, because provider ids carry the organisation as a path segment instead.
 */
export function leaderboardRowKeys(
  displayName: string,
  organization?: string | null
): LeaderboardRowKeys {
  const name = String(displayName ?? "");
  const parenMatch = name.match(/\(([^()]*)\)\s*$/);
  const base = parenMatch ? name.slice(0, parenMatch.index).trim() : name.trim();
  const variantTokens = parenMatch
    ? parenMatch[1]
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
  const date = variantTokens.find((token) => EIGHT_DIGIT_DATE.test(token)) ?? null;
  const onlyDates = variantTokens.every((token) => /^[\d-]+$/.test(token));
  const canonical = canonicalQualityKey(base, true);
  const exact = slugModelName(name);
  const org = slugModelName(organization ?? "");
  const withoutOrganization: string[] = [];
  if (org && canonical.startsWith(`${org}-`) && canonical.length > org.length + 1) {
    withoutOrganization.push(canonical.slice(org.length + 1));
  }
  if (org && exact.startsWith(`${org}-`) && exact.length > org.length + 1) {
    withoutOrganization.push(exact.slice(org.length + 1));
  }
  return {
    exact,
    canonical,
    dated: date ? `${canonical}-${date}` : null,
    plain: onlyDates,
    withoutOrganization: [...new Set(withoutOrganization)],
  };
}

/**
 * Keys under which a routing candidate is looked up, most specific first:
 *   1. the full id slugged ("nvidia/nemotron-x" -> "nvidia-nemotron-x"),
 *   2. the last path segment slugged ("openai/gpt-oss-120b" -> "gpt-oss-120b"),
 *   3. the last segment's canonical key ("gpt-5.6-sol-high" -> "gpt-5-6-sol").
 * The provider routing the model (claude, github, groq ...) is never part of the key, so one
 * model reached through two providers gets one score.
 */
export function candidateQualityKeys(model: string): string[] {
  const raw = String(model ?? "").trim();
  if (!raw) return [];
  const lastSegment = raw.includes("/") ? raw.slice(raw.lastIndexOf("/") + 1) : raw;
  const keys = [slugModelName(raw), slugModelName(lastSegment), canonicalQualityKey(lastSegment)];
  return [...new Set(keys.filter(Boolean))];
}

/**
 * Category under which quality rows are stored for a routing task type. The fit-first ranker's
 * "general" task reads the overall ("default") leaderboard; every other task type reads its own row.
 */
export function qualityCategoryForTask(taskType: string): string {
  const task = String(taskType ?? "").toLowerCase();
  return task === "general" || !task ? "default" : task;
}
