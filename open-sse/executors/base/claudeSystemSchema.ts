type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export class ClaudeSystemSchemaError extends Error {
  constructor(public readonly code: string, index: number) {
    super(`${code} at system[${index}]; the request was not dispatched`);
    this.name = "ClaudeSystemSchemaError";
  }
}

// Object key order is immaterial; array order and every schema value are retained.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/**
 * Project privileged inline tool definitions already hoisted into `system` by
 * a Messages gateway. Never inspect user/tool-result content for declarations.
 * The stored transcript and caller's body are not mutated. Unknown control
 * blocks and conflicting definitions fail explicitly instead of losing data.
 */
export function projectClaudeSystemTools(body: JsonRecord): JsonRecord {
  if (!Array.isArray(body.system)) return body;
  const system: unknown[] = [];
  const additions: JsonRecord[] = [];
  const existing = Array.isArray(body.tools) ? body.tools : [];

  for (const [index, block] of body.system.entries()) {
    if (isRecord(block) && block.type === "text" && typeof block.text === "string") {
      system.push(block);
      continue;
    }
    if (!isRecord(block) || block.type !== "tool_addition") {
      throw new ClaudeSystemSchemaError("unsupported_claude_system_block", index);
    }
    const tool = block.tool;
    const definition = isRecord(tool) ? tool.definition : undefined;
    if (!isRecord(tool) || tool.type !== "tool_definition" ||
        !isRecord(definition) || typeof definition.name !== "string" ||
        definition.name.length === 0 || !isRecord(definition.input_schema)) {
      throw new ClaudeSystemSchemaError("invalid_inline_tool_definition", index);
    }
    if (Object.keys(block).some((key) => key !== "type" && key !== "tool") ||
        Object.keys(tool).some((key) => key !== "type" && key !== "definition")) {
      throw new ClaudeSystemSchemaError("unsupported_inline_tool_metadata", index);
    }
    if (body.tools !== undefined && !Array.isArray(body.tools)) {
      throw new ClaudeSystemSchemaError("invalid_claude_tools_array", index);
    }
    const matches = [...existing, ...additions].filter((entry) =>
      isRecord(entry) && entry.name === definition.name);
    if (matches.some((entry) => canonical(entry) !== canonical(definition))) {
      throw new ClaudeSystemSchemaError("conflicting_inline_tool_definition", index);
    }
    if (matches.length === 0) additions.push(structuredClone(definition));
  }

  if (system.length === body.system.length) return body;
  // Clone the projected body before downstream OAuth sanitation can mutate it.
  return structuredClone({ ...body, system, tools: [...existing, ...additions] });
}

/** The observed native API rejects CLI-only adaptive display="updates". */
export function normalizeClaudeAdaptiveDisplay(body: JsonRecord): JsonRecord {
  if (!isRecord(body.thinking) || body.thinking.type !== "adaptive" ||
      body.thinking.display !== "updates") return body;
  const thinking = { ...body.thinking };
  delete thinking.display;
  return { ...body, thinking };
}
