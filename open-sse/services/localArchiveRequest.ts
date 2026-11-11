import { openaiResponsesToOpenAIRequest } from "../translator/request/openai-responses.ts";
import { collectResponsesTools } from "../translator/request/openai-responses/additionalTools.ts";
import { normalizeResponsesInputForChat } from "../utils/responsesInputNormalization.ts";
import { hasVisualInput } from "./localFinalFallback.mjs";

function assertLocalResponsesInput(body: any) {
  if (hasVisualInput(body)) throw new Error("archive_unsupported_visual_budget");
  const items = normalizeResponsesInputForChat(body.input) as any[];
  const pending = new Set<string>();
  for (const item of items) {
    if (["function_call", "custom_tool_call"].includes(item?.type)) {
      if (
        typeof item.call_id !== "string" ||
        !item.call_id.trim() ||
        pending.has(item.call_id) ||
        typeof item.name !== "string" ||
        !item.name.trim()
      )
        throw new Error("archive_invalid_tool_pair");
      pending.add(item.call_id);
    } else if (["function_call_output", "custom_tool_call_output"].includes(item?.type)) {
      if (!pending.delete(item.call_id)) throw new Error("archive_orphan_tool_result");
    }
  }
  if (pending.size) throw new Error("archive_incomplete_tool_cycle");
  const checkTool = (tool: any) => {
    if (tool?.type === "namespace") {
      for (const member of tool.tools ?? []) checkTool(member);
    } else if (
      /^(image_generation|web_search)/.test(String(tool?.type ?? "")) ||
      (String(tool?.type ?? "").startsWith("tool_search") && tool.execution !== "client")
    )
      throw new Error("archive_invalid_responses_hosted_tool");
  };
  for (const tool of collectResponsesTools(body.tools, items)) checkTool(tool);
}

// Archive planning consumes Chat messages. Responses input is converted here by
// the same translator used by dispatch, before any token or partition check.
// The incoming body remains untouched and is retained in the archive revision.
export function prepareLocalArchiveRequest(body: any) {
  if (body?.input === undefined) return { body, originalBody: undefined, toolIdentity: null };
  assertLocalResponsesInput(body);
  const originalBody = structuredClone(body);
  const converted = openaiResponsesToOpenAIRequest("ollama-local", structuredClone(body), false, {
    provider: "ollama-local",
  }) as any;
  return {
    body: converted,
    originalBody,
    toolIdentity: converted._toolNameMap instanceof Map ? converted._toolNameMap : null,
  };
}

export function bindLocalArchiveToolIdentity(body: any, identity: Map<string, unknown> | null) {
  // structuredClone used by the planner does not copy the translator's
  // nonenumerable identity map. Core extracts/deletes this private channel
  // before constructing the upstream wire request, as for ordinary translation.
  if (identity) body._toolNameMap = new Map(identity);
  return body;
}
