/** Structural request boundary only. Never inspect tool output payloads for control blocks. */
export interface ToolContinuationBoundary {
  continuation: boolean;
  protocol: "messages" | "responses" | "gemini" | "unknown";
  reason: string;
  toolResultCount: number;
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// IDs are opaque strings: never stringify numeric IDs or parse numeric-looking strings.
function identity(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

export function classifyToolContinuation(
  body: Record<string, unknown>,
): ToolContinuationBoundary {
  const arrays = ["messages", "input", "contents"].filter((key) =>
    Array.isArray(body[key]),
  );
  const result = (
    continuation: boolean,
    reason: string,
    protocol: ToolContinuationBoundary["protocol"] = "unknown",
    toolResultCount = 0,
  ): ToolContinuationBoundary => ({
    continuation,
    protocol,
    reason,
    toolResultCount,
  });
  if (arrays.length !== 1) {
    return result(
      false,
      arrays.length ? "ambiguous_protocol_arrays" : "no_tool_boundary",
    );
  }
  const key = arrays[0];
  const protocol =
    key === "input" ? "responses" : key === "contents" ? "gemini" : "messages";
  const entries = body[key] as unknown[];
  // Framework control messages can follow a result. Assistant output and new user
  // content are real boundaries and MUST NOT be skipped to find an older result.
  let tail: unknown;
  for (let i = entries.length - 1; i >= 0; i--) {
    const entry = entries[i];
    if (record(entry) && ["system", "developer"].includes(String(entry.role)))
      continue;
    tail = entry;
    break;
  }
  if (!record(tail)) return result(false, "no_tool_boundary", protocol);
  if (protocol === "responses" && tail.type === "function_call_output") {
    return identity(tail.call_id)
      ? result(true, "tool_result_tail", protocol, 1)
      : result(false, "invalid_tool_identity", protocol);
  }
  if (protocol === "responses" && tail.type === "function_call") {
    return result(identity(tail.call_id), "assistant_tool_boundary", protocol);
  }
  if (tail.role === "tool" || tail.role === "function") {
    const valid =
      tail.role === "tool" ? identity(tail.tool_call_id) : identity(tail.name);
    return result(
      valid,
      valid ? "tool_result_tail" : "invalid_tool_identity",
      protocol,
      valid ? 1 : 0,
    );
  }
  const blocks = Array.isArray(tail.content)
    ? tail.content
    : Array.isArray(tail.parts)
      ? tail.parts
      : [];
  if (tail.role === "user") {
    let results = 0;
    for (const block of blocks) {
      if (!record(block)) return result(false, "fresh_user_content", protocol);
      if (
        block.type === "tool_result" ||
        block.type === "function_call_output"
      ) {
        const id =
          block.type === "tool_result" ? block.tool_use_id : block.call_id;
        if (!identity(id))
          return result(false, "invalid_tool_identity", protocol);
        results++;
      } else if (protocol === "gemini" && record(block.functionResponse)) {
        const response = block.functionResponse;
        if (
          !identity(response.name) ||
          (response.id !== undefined && !identity(response.id))
        ) {
          return result(false, "invalid_tool_identity", protocol);
        }
        results++;
      } else {
        // Mixed new text/images and results cannot prove a tool-only continuation.
        return result(false, "fresh_user_content", protocol);
      }
    }
    return result(
      results > 0,
      results ? "tool_result_tail" : "fresh_user_content",
      protocol,
      results,
    );
  }
  if (tail.role === "assistant" || tail.role === "model") {
    const calls = Array.isArray(tail.tool_calls) ? tail.tool_calls : [];
    const pending =
      calls.length > 0
        ? calls.every((call) => record(call) && identity(call.id))
        : record(tail.function_call) && identity(tail.function_call.name)
          ? true
          : blocks.some(
              (block) =>
                record(block) &&
                ((block.type === "tool_use" && identity(block.id)) ||
                  (protocol === "gemini" &&
                    record(block.functionCall) &&
                    identity(block.functionCall.name) &&
                    (block.functionCall.id === undefined ||
                      identity(block.functionCall.id)))),
            );
    return result(
      pending,
      pending ? "assistant_tool_boundary" : "assistant_turn_boundary",
      protocol,
    );
  }
  return result(false, "no_tool_boundary", protocol);
}
