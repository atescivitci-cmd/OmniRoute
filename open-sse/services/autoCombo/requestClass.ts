/**
 * Request class: a small, name-blind label for the KIND of request a usage row describes.
 *
 * Why it exists: outcome evidence is only worth something when it describes the request being
 * routed. A model that answers a tiny content-free probe says little about whether it survives a
 * long tool session, so success rates are kept per class and read per class (see classEvidence.ts).
 *
 * The class is derived from signals every request already carries and nothing else:
 *  - tools: any tool or function definition, tool choice, or tool call/result in the history
 *  - size: approximate input tokens in three buckets (below 8k, 8k to 32k, above 32k)
 *  - stream: the client asked for a streamed answer
 * It is written as three characters, for example `t2s` (tools, large, streamed) or `c0n`
 * (no tools, small, not streamed). The same function runs when a usage row is written and when a
 * request is ranked, so a row and the request it describes always get the same label.
 *
 * Never reads a provider, model, client or key name. The size is an estimate (4 characters a
 * token) over the message-bearing fields, bounded in work, never in what it accepts.
 */

/** Upper edges (approximate input tokens) of size buckets 0 and 1. Bucket 2 is everything above. */
export const REQUEST_CLASS_SIZE_EDGES = [8_000, 32_000] as const;

export type RequestClassTier = "light" | "heavy";

export interface ParsedRequestClass {
  tools: boolean;
  size: 0 | 1 | 2;
  stream: boolean;
}

const CLASS_RE = /^([tc])([012])([sn])$/;
const CHARS_PER_TOKEN = 4;
const MAX_NODES = 40_000;
const MAX_DEPTH = 10;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

/** Total string length under `value`, bounded in nodes and depth so a hostile body costs little. */
function approxChars(value: unknown, budget: { nodes: number }, depth = 0): number {
  if (value == null || depth > MAX_DEPTH || budget.nodes <= 0) return 0;
  budget.nodes -= 1;
  if (typeof value === "string") return value.length;
  if (typeof value !== "object") return 0;
  let total = 0;
  if (Array.isArray(value)) {
    for (const entry of value) total += approxChars(entry, budget, depth + 1);
    return total;
  }
  for (const entry of Object.values(value as Record<string, unknown>)) {
    total += approxChars(entry, budget, depth + 1);
  }
  return total;
}

const SIZE_FIELDS = [
  "messages",
  "input",
  "contents",
  "system",
  "instructions",
  "prompt",
  "tools",
  "functions",
];

/** Approximate input tokens of a request body (4 characters a token over the message fields). */
export function approximateInputTokens(body: Record<string, unknown>): number {
  const budget = { nodes: MAX_NODES };
  let chars = 0;
  for (const field of SIZE_FIELDS) chars += approxChars(body[field], budget);
  const nested = isRecord(body.request) ? body.request : null;
  if (nested) chars += approxChars(nested.contents, budget);
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

const TOOL_BLOCK_TYPES = new Set([
  "tool_use",
  "tool_result",
  "function_call",
  "function_call_output",
  "server_tool_use",
  "mcp_tool_use",
]);

function messageUsesTools(entry: unknown): boolean {
  if (!isRecord(entry)) return false;
  if (entry.role === "tool" || entry.role === "function") return true;
  if (entry.tool_calls != null || entry.function_call != null) return true;
  if (typeof entry.type === "string" && TOOL_BLOCK_TYPES.has(entry.type)) return true;
  const content = entry.content;
  if (Array.isArray(content)) {
    return content.some(
      (block) =>
        isRecord(block) && typeof block.type === "string" && TOOL_BLOCK_TYPES.has(block.type)
    );
  }
  return false;
}

/** True when the request defines, chooses or already used a tool. */
export function requestUsesTools(body: Record<string, unknown>): boolean {
  for (const key of ["tools", "functions"]) {
    const value = body[key];
    if (Array.isArray(value) && value.length > 0) return true;
  }
  const choice = body.tool_choice;
  if (choice != null && choice !== "none" && choice !== false) return true;
  for (const key of ["messages", "input"]) {
    const value = body[key];
    if (Array.isArray(value) && value.some(messageUsesTools)) return true;
  }
  return false;
}

export function requestSizeBucket(approxTokens: number): 0 | 1 | 2 {
  if (approxTokens < REQUEST_CLASS_SIZE_EDGES[0]) return 0;
  if (approxTokens < REQUEST_CLASS_SIZE_EDGES[1]) return 1;
  return 2;
}

/** The class of a request body, or null when the body is not an object. */
export function deriveRequestClass(body: unknown): string | null {
  if (!isRecord(body)) return null;
  const tools = requestUsesTools(body) ? "t" : "c";
  const size = requestSizeBucket(approximateInputTokens(body));
  const stream = body.stream === true ? "s" : "n";
  return `${tools}${size}${stream}`;
}

export function parseRequestClass(value: unknown): ParsedRequestClass | null {
  if (typeof value !== "string") return null;
  const match = CLASS_RE.exec(value);
  if (!match) return null;
  return {
    tools: match[1] === "t",
    size: Number(match[2]) as 0 | 1 | 2,
    stream: match[3] === "s",
  };
}

/**
 * Evidence tier of a class: `light` is a request with no tools and a small input, everything else
 * is `heavy`. Cells are thin, so a class that has few samples borrows strength from its tier.
 */
export function requestClassTier(value: string): RequestClassTier | null {
  const parsed = parseRequestClass(value);
  if (!parsed) return null;
  return !parsed.tools && parsed.size === 0 ? "light" : "heavy";
}

/** The class a content-free routing probe is recorded under: no tools, small, streamed. */
export const PROBE_REQUEST_CLASS = "c0s";
