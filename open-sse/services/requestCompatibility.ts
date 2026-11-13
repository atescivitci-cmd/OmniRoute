/**
 * Pure request-feature planning. The target profile is server-owned evidence;
 * provider/model labels or fields in the request cannot create support,
 * entitlement, replay permission or dispatch authority.
 *
 * Accepted bodies are independent snapshots. Callers must retain an independent
 * before-snapshot before executor mutation for the final native integrity check.
 * This module performs no I/O, persistence, routing or retries.
 */
type JsonRecord = Record<string, unknown>;

export interface RequestCompatibilityTarget {
  provider: string;
  model: string;
  contextManagement: "native" | "unsupported" | "unknown";
  /** Null/absent means this planner has no qualified tool limit, not unlimited support. */
  maxTools?: number | null;
  /** Existing, qualified target rules only. These are top-level field names. */
  unsupportedControls?: string[];
}

export type RequestCompatibilityRefusalCode =
  | "request_context_management_unavailable"
  | "request_tool_limit_exceeded"
  | "request_required_control_unsupported";
export type RequestCompatibilityErrorCode =
  RequestCompatibilityRefusalCode | "request_integrity_mismatch";

export interface RequestCompatibilityAccepted {
  ok: true;
  body: JsonRecord;
  adaptations: string[];
}
export interface RequestCompatibilityRefused {
  ok: false;
  code: RequestCompatibilityRefusalCode;
}
export type RequestCompatibilityAssessment =
  RequestCompatibilityAccepted | RequestCompatibilityRefused;
export type RequestCompatibilityProbe =
  { ok: true; adaptations: string[] } | RequestCompatibilityRefused;

export class RequestCompatibilityError extends Error {
  readonly code: RequestCompatibilityErrorCode;

  constructor(code: RequestCompatibilityErrorCode) {
    super(code);
    this.name = "RequestCompatibilityError";
    this.code = code;
  }
}

function isRecord(value: unknown): value is JsonRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function hasDefined(record: JsonRecord, key: string): boolean {
  return Object.hasOwn(record, key) && record[key] !== undefined;
}

function hasOnlyKeys(record: JsonRecord, keys: readonly string[]): boolean {
  return Object.keys(record).every((key) => keys.includes(key));
}

function isExactInactiveContextHint(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["edits"])) return false;
  if (!Array.isArray(value.edits) || value.edits.length !== 1) return false;
  const edit = value.edits[0];
  return (
    isRecord(edit) &&
    hasOnlyKeys(edit, ["type", "keep"]) &&
    edit.type === "clear_thinking_20251015" &&
    edit.keep === "all"
  );
}

/**
 * Server-side history trimming only. A target without it receives the full,
 * unedited history, so no instruction or content is lost by leaving it out.
 * Any other edit kind, key or shape is unknown and still refuses.
 */
function isHistoryTrimOnly(value: unknown): boolean {
  if (!isRecord(value) || !hasOnlyKeys(value, ["edits"])) return false;
  if (!Array.isArray(value.edits) || value.edits.length === 0 || value.edits.length > 8) {
    return false;
  }
  return value.edits.every(
    (edit) =>
      isRecord(edit) &&
      typeof edit.type === "string" &&
      /^clear_(thinking|tool_uses)_\d{8}$/.test(edit.type)
  );
}

/** A text block may retain an ordinary cache hint, but cannot hide opaque blocks. */
function isTextContent(value: unknown): boolean {
  if (typeof value === "string") return true;
  return (
    Array.isArray(value) &&
    value.every(
      (block) =>
        isRecord(block) &&
        hasOnlyKeys(block, ["type", "text", "cache_control"]) &&
        block.type === "text" &&
        typeof block.text === "string" &&
        (!hasDefined(block, "cache_control") || isRecord(block.cache_control))
    )
  );
}

const CONTINUATION_KEYS = [
  "previous_response_id",
  "conversation",
  "container",
  "conversation_id",
  "thread_id",
  "response_id",
  // A mixed dialect cannot establish that the visible messages are the full input.
  "input",
  "contents",
  // Alternate modality/opaque carriers cannot establish a text-only exemption.
  "images",
  "image",
  "image_url",
  "input_image",
  "attachments",
  "files",
  "audio",
  "video",
  "documents",
  "signature",
  "encrypted_content",
  "redacted_thinking",
  "tool_calls",
  "function_call",
  "tool_results",
] as const;

function hasFreshTextInput(body: JsonRecord): boolean {
  if (CONTINUATION_KEYS.some((key) => hasDefined(body, key))) return false;
  if (hasDefined(body, "tool_choice")) return false;
  if (hasDefined(body, "tools") && (!Array.isArray(body.tools) || body.tools.length !== 0)) {
    return false;
  }
  if (!Array.isArray(body.messages) || body.messages.length !== 1) return false;
  const message = body.messages[0];
  if (
    !isRecord(message) ||
    !hasOnlyKeys(message, ["role", "content"]) ||
    message.role !== "user" ||
    !isTextContent(message.content)
  ) {
    return false;
  }
  if (hasDefined(body, "system") && !isTextContent(body.system)) return false;
  // Top-level thinking is an execution preference, not prior thinking history.
  // Do not discard it. Unknown/opaque thinking carriers cannot qualify a no-op.
  if (hasDefined(body, "thinking")) {
    if (
      !isRecord(body.thinking) ||
      !hasOnlyKeys(body.thinking, ["type", "budget_tokens", "display"]) ||
      !["adaptive", "enabled", "disabled"].includes(String(body.thinking.type))
    ) {
      return false;
    }
  }
  return true;
}

/** Sanitized, content-free description of why a target refused a request. */
export interface RequestCompatibilityRefusalDiagnostics {
  code: string;
  provider: string;
  model: string;
  targetContextManagement: string;
  maxTools: number | null;
  toolCount: number | null;
  toolTypes: string[];
  unsupportedControls: string[];
  unsupportedControlsPresent: string[];
  contextManagement: { present: boolean; keys: string[]; editTypes: string[] };
  bodyKeys: string[];
}

const SAFE_NAME = /^[a-z0-9_]{1,40}$/;
const SAFE_EDIT_TYPE = /^[a-z][a-z0-9_]{0,63}$/;
const DIAGNOSTIC_LIST_CAP = 40;

/** Field/type NAMES only, from a closed character set; anything else collapses to "<other>". */
function safeNames(values: unknown[], pattern = SAFE_NAME): string[] {
  const out = new Set<string>();
  for (const value of values) {
    out.add(typeof value === "string" && pattern.test(value) ? value : "<other>");
    if (out.size >= DIAGNOSTIC_LIST_CAP) break;
  }
  return [...out];
}

/**
 * Describe a refusal for operator logs without copying any request content: never values,
 * prompts, tool definitions or identifiers from the body — only field names, edit-type
 * names, counts and the target's own server-owned profile. Never throws.
 */
export function describeRequestCompatibilityRefusal(
  body: JsonRecord,
  target: RequestCompatibilityTarget,
  code: string
): RequestCompatibilityRefusalDiagnostics {
  const record = isRecord(body) ? body : {};
  const tools = Array.isArray(record.tools) ? record.tools : null;
  const unsupported = Array.isArray(target?.unsupportedControls) ? target.unsupportedControls : [];
  const cm = record.context_management;
  const edits = isRecord(cm) && Array.isArray(cm.edits) ? cm.edits : [];
  return {
    code: SAFE_NAME.test(code) ? code : "<other>",
    provider: String(target?.provider ?? ""),
    model: String(target?.model ?? ""),
    targetContextManagement: String(target?.contextManagement ?? ""),
    maxTools: typeof target?.maxTools === "number" ? target.maxTools : null,
    toolCount: tools ? tools.length : null,
    toolTypes: tools ? safeNames(tools.map((t) => (isRecord(t) ? t.type : undefined))) : [],
    unsupportedControls: safeNames(unsupported),
    unsupportedControlsPresent: safeNames(unsupported.filter((field) => hasDefined(record, field))),
    contextManagement: {
      present: hasDefined(record, "context_management"),
      keys: isRecord(cm) ? safeNames(Object.keys(cm)) : [],
      editTypes: safeNames(
        edits.map((edit) => (isRecord(edit) ? edit.type : undefined)),
        SAFE_EDIT_TYPE
      ),
    },
    bodyKeys: safeNames(Object.keys(record)),
  };
}

function refusal(code: RequestCompatibilityRefusalCode): RequestCompatibilityRefused {
  return { ok: false, code };
}

function validTarget(target: RequestCompatibilityTarget): boolean {
  return (
    isRecord(target) &&
    typeof target.provider === "string" &&
    target.provider.trim().length > 0 &&
    typeof target.model === "string" &&
    target.model.trim().length > 0 &&
    ["native", "unsupported", "unknown"].includes(target.contextManagement) &&
    (target.maxTools == null || (Number.isSafeInteger(target.maxTools) && target.maxTools >= 0)) &&
    (target.unsupportedControls === undefined ||
      (Array.isArray(target.unsupportedControls) &&
        target.unsupportedControls.every((key) => typeof key === "string" && key.length > 0)))
  );
}

/**
 * Allocation-light ranking probe. No body snapshot or caller references are
 * returned or cached. The caller still needs assess/require at dispatch time.
 * Validated JSON request bodies are expected, as at the real parser boundary.
 */
export function probeRequestCompatibility(
  body: JsonRecord,
  target: RequestCompatibilityTarget
): RequestCompatibilityProbe {
  try {
    if (!isRecord(body) || !validTarget(target)) {
      return refusal("request_required_control_unsupported");
    }
    if (
      target.maxTools != null &&
      Array.isArray(body.tools) &&
      body.tools.length > target.maxTools
    ) {
      return refusal("request_tool_limit_exceeded");
    }
    if ((target.unsupportedControls || []).some((field) => hasDefined(body, field))) {
      return refusal("request_required_control_unsupported");
    }

    const adaptations: string[] = [];
    if (hasDefined(body, "context_management") && target.contextManagement !== "native") {
      if (isExactInactiveContextHint(body.context_management) && hasFreshTextInput(body)) {
        adaptations.push("omit_inactive_context_management");
      } else if (isHistoryTrimOnly(body.context_management)) {
        adaptations.push("omit_history_trim_context_management");
      } else {
        return refusal("request_context_management_unavailable");
      }
    }

    return { ok: true, adaptations };
  } catch {
    // Malformed/exotic values cannot qualify an adaptation. Never copy their prose.
    return refusal("request_required_control_unsupported");
  }
}

export function assessRequestCompatibility(
  body: JsonRecord,
  target: RequestCompatibilityTarget
): RequestCompatibilityAssessment {
  const probe = probeRequestCompatibility(body, target);
  if (probe.ok === false) return probe;
  try {
    const next = structuredClone(body);
    if (probe.adaptations.some((name) => name.endsWith("_context_management")))
      delete next.context_management;
    return { ok: true, body: next, adaptations: probe.adaptations };
  } catch {
    return refusal("request_required_control_unsupported");
  }
}

export function requireRequestCompatibility(
  body: JsonRecord,
  target: RequestCompatibilityTarget
): RequestCompatibilityAccepted {
  const assessment = assessRequestCompatibility(body, target);
  if (assessment.ok === false) throw new RequestCompatibilityError(assessment.code);
  return assessment;
}

const NATIVE_PROTOCOL_FIELDS = [
  "messages",
  "system",
  "tools",
  "tool_choice",
  "thinking",
  "output_config",
  "context_management",
] as const;

function sameProtocolData(left: unknown, right: unknown, ancestors = new Set<object>()): boolean {
  if (Object.is(left, right)) return true;
  if (left === null || right === null || typeof left !== "object" || typeof right !== "object") {
    return false;
  }
  if (ancestors.has(left) || ancestors.has(right)) return false;
  if (Array.isArray(left) !== Array.isArray(right)) return false;
  if (!Array.isArray(left) && (!isRecord(left) || !isRecord(right))) return false;
  if (Array.isArray(left) && left.length !== (right as unknown[]).length) return false;

  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (
    leftKeys.length !== rightKeys.length ||
    leftKeys.some((key, index) => key !== rightKeys[index])
  ) {
    return false;
  }
  const nextAncestors = new Set(ancestors);
  nextAncestors.add(left);
  nextAncestors.add(right);
  return leftKeys.every((key) =>
    sameProtocolData((left as JsonRecord)[key], (right as JsonRecord)[key], nextAncestors)
  );
}

/**
 * Compare an independently retained before-snapshot with final native data.
 * This is a guard, not provenance: passing the same mutated reference twice
 * cannot attest what existed before mutation. Wire serialization remains a
 * separate boundary, including requested output reserve and endpoint identity.
 */
export function assertNativeProtocolDataUnchanged(before: JsonRecord, after: JsonRecord): void {
  try {
    if (
      !isRecord(before) ||
      !isRecord(after) ||
      NATIVE_PROTOCOL_FIELDS.some(
        (field) =>
          Object.hasOwn(before, field) !== Object.hasOwn(after, field) ||
          !sameProtocolData(before[field], after[field])
      )
    ) {
      throw new RequestCompatibilityError("request_integrity_mismatch");
    }
  } catch {
    throw new RequestCompatibilityError("request_integrity_mismatch");
  }
}
