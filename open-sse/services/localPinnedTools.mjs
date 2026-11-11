const isRecord = (value) =>
  value !== null && typeof value === "object" && !Array.isArray(value);

// Schema object ordering is irrelevant; array order and all values are significant.
const canonical = (value) => {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (isRecord(value)) {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
};

/**
 * Normalize only privileged system/developer instructions. Claude Code may add
 * tool definitions there after discovery. Preserve them as actual tools, not
 * prose. Never discover declarations inside user or tool-result content.
 * The caller archives the unmodified request before this projection.
 */
export function normalizeArchivePinnedInstructions(body, pinned) {
  if (body.tools !== undefined && !Array.isArray(body.tools)) {
    throw new Error("archive_invalid_tools_array");
  }
  const out = structuredClone(body);
  const tools = out.tools ?? [];
  const system = [];
  const append = (content, allowStrings = false) => {
    if (typeof content === "string") {
      system.push({ type: "text", text: content });
      return;
    }
    if (!Array.isArray(content))
      throw new Error("archive_invalid_pinned_instruction");
    for (const block of content) {
      if (allowStrings && typeof block === "string") {
        system.push({ type: "text", text: block });
        continue;
      }
      if (block?.type === "text" && typeof block.text === "string") {
        system.push(structuredClone(block));
        continue;
      }
      if (block?.type !== "tool_addition") {
        throw new Error("archive_invalid_pinned_instruction");
      }
      const tool = block.tool;
      const definition = tool?.definition;
      if (
        !isRecord(tool) ||
        tool.type !== "tool_definition" ||
        !isRecord(definition) ||
        typeof definition.name !== "string" ||
        !/^[a-zA-Z0-9_-]{1,128}$/.test(definition.name) ||
        !isRecord(definition.input_schema) ||
        definition.input_schema.type !== "object"
      ) {
        throw new Error("archive_invalid_inline_tool_definition");
      }
      if (
        Object.keys(block).some((key) => !["type", "tool"].includes(key)) ||
        Object.keys(tool).some((key) => !["type", "definition"].includes(key))
      ) {
        throw new Error("archive_invalid_inline_tool_metadata");
      }
      const matches = tools.filter(
        (entry) => (entry?.name ?? entry?.function?.name) === definition.name,
      );
      if (matches.some((entry) => canonical(entry) !== canonical(definition))) {
        throw new Error("archive_invalid_conflicting_tool_definition");
      }
      if (!matches.length) tools.push(structuredClone(definition));
    }
  };
  append(out.system === undefined ? "" : out.system, true);
  for (const message of pinned) {
    if (!["system", "developer"].includes(message.role)) {
      throw new Error("archive_invalid_pinned_role");
    }
    system.push({
      type: "text",
      text: `[Original ${message.role} instructions]`,
    });
    append(message.content);
  }
  if (out.instructions !== undefined) {
    if (typeof out.instructions !== "string")
      throw new Error("archive_invalid_pinned_instruction");
    append(out.instructions);
    delete out.instructions;
  }
  out.system = system;
  out.tools = tools;
  out.messages = (out.messages ?? []).filter(
    (message) => !["system", "developer"].includes(message.role),
  );
  return out;
}
