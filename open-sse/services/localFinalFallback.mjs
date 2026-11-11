import { createNativeTokenCounter, assertTokenCapacity } from "./localTokenBudget.mjs";
import {
  readResidentCapacity,
  waitForResidentCapacity,
  validateCapacity,
  assertNativeCapacity,
  assertArchiveEndpoint,
  assertSameCapacity,
  MAX_CONTEXT,
} from "./localContext.mjs";
export const LOCAL_MODEL = "qwen3.6:35b-a3b";
export const LOCAL_ROUTE = "ollama-local/" + LOCAL_MODEL;
export const LOCAL_CONTEXT = MAX_CONTEXT;
export function fullInputEstimate(body) {
  return Math.ceil(
    JSON.stringify({
      messages: body.messages ?? body.input ?? [],
      tools: body.tools ?? [],
      system: body.system ?? "",
      instructions: body.instructions ?? "",
    }).length / 4
  );
}
// Examine the complete history, including images nested in tool results. The
// native fallback has no verified visual token budget; remote vision admission
// remains the responsibility of the normal per-target routing pipeline.
export function hasVisualInput(body) {
  const visit = (value) => {
    if (!value || typeof value !== "object") return false;
    if (Array.isArray(value)) return value.some(visit);
    if (
      ["image", "image_url", "input_image", "computer_screenshot"].includes(
        String(value.type ?? "").toLowerCase()
      )
    )
      return true;
    if (Array.isArray(value.images) && value.images.length > 0) return true;
    const inline = value.inlineData ?? value.inline_data;
    if (
      inline &&
      typeof inline === "object" &&
      /^image\//i.test(String(inline.mimeType ?? inline.mime_type ?? ""))
    )
      return true;
    return Object.values(value).some(visit);
  };
  return visit(body.messages ?? body.input ?? body.contents ?? []);
}
// VISION_HISTORY_PLACEHOLDER_V1: an image the model must see now (in the turn after
// the last assistant message) still refuses. Older images are replaced, in this
// fallback's own clone only, with an explicit placeholder so a long session is not
// stranded when no vision route is available.
export const IMAGE_PLACEHOLDER =
  "[Image omitted: no vision-capable route was available, and the local text-only fallback cannot view this earlier image.]";
export function hasVisualLatestTurn(body) {
  const items = body.messages ?? body.input ?? body.contents ?? [];
  if (!Array.isArray(items)) return true;
  let last = -1;
  items.forEach((item, index) => {
    if (item?.role === "assistant" || item?.role === "model") last = index;
  });
  return hasVisualInput({ messages: items.slice(last + 1) });
}
export function replaceHistoryImages(body) {
  const convert = (value) => {
    if (!value || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map(convert);
    const type = String(value.type ?? "").toLowerCase();
    if (type === "image" || type === "image_url") return { type: "text", text: IMAGE_PLACEHOLDER };
    if (type === "input_image") return { type: "input_text", text: IMAGE_PLACEHOLDER };
    const inline = value.inlineData ?? value.inline_data;
    if (
      inline &&
      typeof inline === "object" &&
      /^image\//i.test(String(inline.mimeType ?? inline.mime_type ?? ""))
    )
      return { text: IMAGE_PLACEHOLDER };
    const out = {};
    for (const [key, item] of Object.entries(value)) {
      if (key === "images" && Array.isArray(item) && item.length > 0) continue;
      out[key] = convert(item);
    }
    return out;
  };
  for (const key of ["messages", "input", "contents"])
    if (Array.isArray(body[key])) body[key] = convert(body[key]);
  return body;
}
export async function finalLocalFallback(options, remote) {
  const model = options.combo?.config?.finalLocalFallbackModel;
  if (options.combo?.name !== "ac-terminal-continuity" || model !== LOCAL_ROUTE)
    return remote(options);
  options.signal?.throwIfAborted();
  const original = structuredClone(options.body);
  const result = await remote(options);
  if (result.ok) return result;
  options.signal?.throwIfAborted();
  if (options.isReplayTerminal?.(result) || options.routingAttemptGuard?.terminal()) return result;
  let retry = [404, 408, 410, 429, 500, 502, 503, 504].includes(result.status);
  let remoteCode;
  if (result.status === 400) {
    try {
      remoteCode = (await result.clone().json())?.error?.code;
      retry = remoteCode === "context_length_exceeded";
    } catch {}
  }
  options.signal?.throwIfAborted();
  if (!retry) return result;
  const cost = options.combo.config.zeroAdditionalCostProviders ?? [];
  if (
    !cost.includes("ollama-local") ||
    !(options.combo.allowedProviders ?? []).includes("ollama-local")
  )
    return result;
  if (hasVisualInput(original)) {
    // Keep the concrete provider's context failure. Replacing it with a local
    // tokenizer error hid the real admission blocker and caused futile retries.
    if (remoteCode === "context_length_exceeded") return result;
    if (!hasVisualLatestTurn(original)) {
      replaceHistoryImages(original);
      options.log?.warn?.(
        "COMBO",
        "Final local fallback: replaced earlier image blocks with text placeholders (no vision route available)"
      );
    }
  }
  if (hasVisualInput(original)) {
    return Response.json(
      {
        error: {
          type: "invalid_request_error",
          code: "capability_mismatch",
          message:
            "No authorized vision-capable route admitted this image-bearing request. The text-only local fallback cannot admit images. Original history was preserved; no local inference was dispatched.",
          details: {
            required_capability: "vision",
            local_fallback_supports_vision: false,
            remote_status: result.status,
          },
        },
      },
      { status: 400 }
    );
  }
  const output = Number(
    original.max_tokens ?? original.max_completion_tokens ?? original.max_output_tokens ?? 4096
  );
  if (
    fullInputEstimate(original) + Math.max(1, output) + 1024 >= LOCAL_CONTEXT &&
    !options.combo.config.localArchiveContinuation
  )
    return result;
  const attemptLocal = async (signal = options.signal) => {
    try {
      signal?.throwIfAborted();
      if (options.isModelAvailable) {
        const available = await options.isModelAvailable(LOCAL_ROUTE, {
          kind: "model",
          provider: "ollama-local",
          modelStr: LOCAL_ROUTE,
        });
        signal?.throwIfAborted();
        if (!available) return result;
      }
      signal?.throwIfAborted();
      options.log?.info?.(
        "COMBO",
        "Remote combo exhausted; trying final local fallback " + LOCAL_ROUTE
      );
      const local = await options.handleSingleModel(structuredClone(original), LOCAL_ROUTE, {
        kind: "model",
        provider: "ollama-local",
        modelStr: LOCAL_ROUTE,
        modelAbortSignal: signal,
      });
      signal?.throwIfAborted();
      // A successful eligible fallback still wins. If it cannot serve the request,
      // retain the remote context error for native compaction, for text and images.
      if (options.isReplayTerminal?.(local)) return local;
      if (remoteCode === "context_length_exceeded" && !local.ok) {
        void local.body?.cancel().catch(() => {});
        return result;
      }
      return local;
    } catch (error) {
      // Cancellation is never a request to compact or dispatch another inference.
      signal?.throwIfAborted();
      if (
        error?.name === "AbortError" ||
        error?.details?.execution_outcome === "uncertain" ||
        error?.code?.includes("execution_uncertain") ||
        remoteCode !== "context_length_exceeded"
      )
        throw error;
      options.log?.warn?.("COMBO", "Final local fallback failed; preserving remote context error");
      return result;
    }
  };
  return options.runFinalLocal ? options.runFinalLocal(attemptLocal) : attemptLocal();
}
export function buildNativeRequest(input, body, residentCapacity) {
  const capacity = validateCapacity(residentCapacity);
  if (!Array.isArray(body.messages)) throw new Error("Local fallback requires translated messages");
  let messages = body.messages.map((message) => {
    let content = message.content ?? "";
    const images = [];
    if (Array.isArray(content))
      content = content
        .map((part) => {
          if (part.type === "text" && typeof part.text === "string") return part.text;
          if (part.type === "image_url") {
            const url = typeof part.image_url === "string" ? part.image_url : part.image_url?.url;
            const match = typeof url === "string" && url.match(/^data:image\/[^;]+;base64,(.+)$/s);
            if (!match) throw new Error("Local fallback cannot fetch remote image URLs");
            images.push(match[1]);
            return "";
          }
          throw new Error("Unsupported local content block; refusing to discard it");
        })
        .join("\n");
    if (typeof content !== "string") throw new Error("Unsupported local content type");
    const value = { role: message.role === "developer" ? "system" : message.role, content };
    if (images.length) value.images = images;
    if (message.reasoning_content !== undefined) value.thinking = message.reasoning_content;
    if (message.tool_call_id) value.tool_call_id = message.tool_call_id;
    if (message.name) value.tool_name = message.name;
    if (message.tool_calls)
      value.tool_calls = message.tool_calls.map((call) => ({
        id: call.id,
        function: {
          name: call.function.name,
          arguments:
            typeof call.function.arguments === "string"
              ? JSON.parse(call.function.arguments)
              : call.function.arguments,
        },
      }));
    return value;
  });
  const pinned = messages.filter((m) => m.role === "system");
  if (pinned.length > 1 || (pinned.length && messages[0].role !== "system"))
    messages = [
      {
        role: "system",
        content: pinned
          .map((m, i) => `[Original system instructions ${i + 1}]\n${m.content}`)
          .join("\n\n"),
      },
      ...messages.filter((m) => m.role !== "system"),
    ];
  if (body.system || body.instructions)
    throw new Error("Untranslated system instructions; refusing to discard them");
  const options = {
    num_ctx: capacity.context,
    num_predict: Number(body.max_tokens ?? body.max_completion_tokens ?? 4096),
  };
  for (const key of [
    "temperature",
    "top_p",
    "seed",
    "presence_penalty",
    "frequency_penalty",
    "stop",
  ])
    if (body[key] !== undefined) options[key] = body[key];
  const request = {
    model: LOCAL_MODEL,
    messages,
    stream: !!input.stream,
    truncate: false,
    shift: false,
    options,
  };
  if (body.tools) request.tools = structuredClone(body.tools);
  if (body.reasoning_effort !== undefined)
    request.think = !["none", "off", "disabled"].includes(body.reasoning_effort);
  if (body.response_format?.type === "json_object") request.format = "json";
  else if (body.response_format?.type === "json_schema")
    request.format = body.response_format.json_schema?.schema;
  return request;
}
export function nativeRequest(input, body, residentCapacity) {
  const request = buildNativeRequest(input, body, residentCapacity);
  assertNativeCapacity(request, residentCapacity);
  return request;
}
function usage(event) {
  return {
    prompt_tokens: event.prompt_eval_count ?? 0,
    completion_tokens: event.eval_count ?? 0,
    total_tokens: (event.prompt_eval_count ?? 0) + (event.eval_count ?? 0),
  };
}
function toolCalls(calls) {
  return (calls ?? []).map((call, index) => ({
    index,
    id: call.id ?? "local_tool_" + index,
    type: "function",
    function: {
      name: call.function.name,
      arguments: JSON.stringify(call.function.arguments ?? {}),
    },
  }));
}
export async function executeNativeLocal(input, executor, fetcher = fetch) {
  const configured = executor.buildUrl(input.model, input.stream, 0, input.credentials);
  const origin = new URL(configured);
  if (origin.protocol !== "http:" || !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname))
    throw new Error("Local fallback endpoint must remain loopback HTTP");
  const url = origin.origin + "/api/chat";
  const archiveToken =
    typeof input.clientHeaders?.get === "function"
      ? input.clientHeaders.get("x-omniroute-local-archive")
      : Object.entries(input.clientHeaders ?? {}).find(
          ([key]) => key.toLowerCase() === "x-omniroute-local-archive"
        )?.[1];
  const body = executor.transformRequest(
    input.model,
    structuredClone(input.body),
    input.stream,
    input.credentials
  );
  let request, capacity;
  try {
    if (archiveToken) assertArchiveEndpoint(origin.origin);
    capacity = await waitForResidentCapacity(origin.origin, fetcher, input.signal);
    if (archiveToken) {
      request = buildNativeRequest(
        input,
        {
          ...body,
          max_tokens: Math.min(Number(input.body?.max_tokens ?? body.max_tokens ?? 8192), 8192),
          reasoning_effort: "none",
        },
        capacity
      );
      request.think = false;
    } else request = nativeRequest(input, body, capacity);
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    return {
      response: Response.json(
        {
          error: {
            code: error.code ?? "unsupported_local_content",
            message: error.message,
            details: error.details,
          },
        },
        { status: error.status ?? 400 }
      ),
      url,
      headers: {},
      transformedBody: "",
    };
  }
  let response;
  try {
    if (archiveToken)
      response = await (
        await import(
          /* webpackIgnore: true */ "file:///opt/homebrew/lib/node_modules/omniroute/open-sse/services/localArchiveContinuation.mjs"
        )
      ).inferWithArchive(request, input, url, fetcher);
    else {
      assertSameCapacity(
        capacity,
        await readResidentCapacity(origin.origin, fetcher, input.signal)
      );
      assertNativeCapacity(request, capacity);
      response = await fetcher(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(request),
        signal: input.signal,
      });
    }
  } catch (error) {
    input.signal?.throwIfAborted();
    if (error?.name === "AbortError") throw error;
    return {
      response: Response.json(
        {
          error: {
            code: error.code ?? "local_archive_continuation_failed",
            message: error.message,
            details: error.details,
          },
        },
        { status: error.status ?? 400 }
      ),
      url,
      headers: {},
      transformedBody: JSON.stringify(request),
    };
  }
  if (!response.ok) return { response, url, headers: {}, transformedBody: JSON.stringify(request) };
  const id = "local_" + Date.now();
  const created = Math.floor(Date.now() / 1000);
  if (!input.stream) {
    const event = await response.json();
    const message = { ...event.message, tool_calls: toolCalls(event.message?.tool_calls) };
    if (!message.tool_calls.length) delete message.tool_calls;
    return {
      response: Response.json({
        id,
        object: "chat.completion",
        created,
        model: LOCAL_MODEL,
        choices: [
          {
            index: 0,
            message,
            finish_reason: message.tool_calls
              ? "tool_calls"
              : event.done_reason === "length"
                ? "length"
                : "stop",
          },
        ],
        usage: usage(event),
      }),
      url,
      headers: {},
      transformedBody: JSON.stringify(request),
    };
  }
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let pending = "",
    toolsSeen = false,
    toolIndex = 0;
  const output = new ReadableStream({
    async pull(controller) {
      try {
        const { value, done } = await reader.read();
        pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
        const lines = pending.split("\n");
        pending = lines.pop() ?? "";
        if (done && pending) {
          lines.push(pending);
          pending = "";
        }
        for (const line of lines) {
          if (!line.trim()) continue;
          const event = JSON.parse(line);
          if (event.error) throw new Error(event.error);
          const delta = {};
          if (event.message?.role) delta.role = event.message.role;
          if (event.message?.content) delta.content = event.message.content;
          if (event.message?.thinking) delta.reasoning_content = event.message.thinking;
          if (event.message?.tool_calls?.length) {
            toolsSeen = true;
            delta.tool_calls = toolCalls(event.message.tool_calls).map((call) => ({
              ...call,
              index: toolIndex++,
            }));
          }
          const chunk = {
            id,
            object: "chat.completion.chunk",
            created,
            model: LOCAL_MODEL,
            choices: [
              {
                index: 0,
                delta,
                finish_reason: event.done
                  ? toolsSeen
                    ? "tool_calls"
                    : event.done_reason === "length"
                      ? "length"
                      : "stop"
                  : null,
              },
            ],
          };
          if (event.done) chunk.usage = usage(event);
          controller.enqueue(encoder.encode("data: " + JSON.stringify(chunk) + "\n\n"));
        }
        if (done) {
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        }
      } catch (error) {
        await reader.cancel().catch(() => {});
        controller.error(error);
      }
    },
    async cancel(reason) {
      await reader.cancel(reason);
    },
  });
  return {
    response: new Response(output, { headers: { "Content-Type": "text/event-stream" } }),
    url,
    headers: {},
    transformedBody: JSON.stringify(request),
  };
}
