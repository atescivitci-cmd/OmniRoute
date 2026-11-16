/**
 * Shared request-shape fixtures for the "light by ask" classifier work (2026-11-16).
 * Used by tests/unit/light-by-ask-20261116.test.ts and
 * scripts/ad-hoc/light-by-ask-replay-20261116.mts. Pure data builders, no imports.
 */

export type Body = Record<string, unknown>;

/** 120 function tools, like a terminal Codex session attaches to every turn. */
export function codexTools(count = 120): Body[] {
  return Array.from({ length: count }, (_, i) => ({
    type: "function",
    name: i === 0 ? "exec_command" : i === 1 ? "apply_patch" : `mcp__server__tool_${i}`,
    description: `Tool number ${i}.`,
    parameters: { type: "object", properties: { arg: { type: "string" } } },
  }));
}

/** Large Codex-style system prompt. Optionally seeds words that match the heavy/critical regexes. */
export function codexInstructions(chars = 90_000, seed = ""): string {
  const filler = "You are a coding agent. Follow the repository conventions carefully. ";
  return (seed + " " + filler.repeat(Math.ceil(chars / filler.length))).slice(0, chars);
}

export function userMsg(text: string): Body {
  return { type: "message", role: "user", content: [{ type: "input_text", text }] };
}

export function assistantMsg(text: string): Body {
  return { type: "message", role: "assistant", content: [{ type: "output_text", text }] };
}

export function fnCall(name: string, args = "{}", callId = "call_1"): Body {
  return { type: "function_call", name, arguments: args, call_id: callId };
}

export function fnOutput(output: string, callId = "call_1"): Body {
  return { type: "function_call_output", call_id: callId, output };
}

export const ENV_CONTEXT = userMsg(
  "<environment_context>\n  <cwd>/Users/x/project</cwd>\n  <shell>zsh</shell>\n</environment_context>"
);

export interface CodexOptions {
  history?: Body[];
  tools?: number;
  instructionsChars?: number;
  instructionsSeed?: string;
  effort?: string | null;
  extra?: Body;
}

/** Responses-API body as terminal Codex sends it. */
export function codexBody(ask: string, opts: CodexOptions = {}): Body {
  const body: Body = {
    model: "auto",
    instructions: codexInstructions(opts.instructionsChars ?? 90_000, opts.instructionsSeed ?? ""),
    input: [ENV_CONTEXT, ...(opts.history ?? []), userMsg(ask)],
    tools: codexTools(opts.tools ?? 120),
    stream: true,
    ...(opts.effort === null ? {} : { reasoning: { effort: opts.effort ?? "medium" } }),
    ...(opts.extra ?? {}),
  };
  return body;
}

/** Chat-completions body with tool inventory. */
export function chatBody(
  ask: string,
  opts: { history?: Body[]; tools?: number; system?: string; extra?: Body } = {}
): Body {
  return {
    model: "auto",
    messages: [
      { role: "system", content: opts.system ?? codexInstructions(60_000) },
      ...(opts.history ?? []),
      { role: "user", content: ask },
    ],
    tools: codexTools(opts.tools ?? 40).map((t) => ({
      type: "function",
      function: { name: t.name, description: t.description, parameters: t.parameters },
    })),
    ...(opts.extra ?? {}),
  };
}

export function chatAssistantToolCall(name: string): Body {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: "c1", type: "function", function: { name, arguments: "{}" } }],
  };
}

/** Anthropic messages body with tool inventory. */
export function anthropicBody(
  ask: string,
  opts: { history?: Body[]; tools?: number; system?: string; extra?: Body } = {}
): Body {
  return {
    model: "auto",
    max_tokens: 4096,
    system: opts.system ?? codexInstructions(60_000),
    messages: [...(opts.history ?? []), { role: "user", content: [{ type: "text", text: ask }] }],
    tools: codexTools(opts.tools ?? 40).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: t.parameters,
    })),
    ...(opts.extra ?? {}),
  };
}

export function anthropicToolUse(name: string): Body {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id: "tu1", name, input: {} }],
  };
}

export function anthropicToolResult(text: string): Body {
  return { role: "user", content: [{ type: "tool_result", tool_use_id: "tu1", content: text }] };
}

/** Gemini-style body. */
export function geminiBody(ask: string, history: Body[] = []): Body {
  return {
    contents: [...history, { role: "user", parts: [{ text: ask }] }],
    tools: [{ functionDeclarations: [{ name: "get_weather" }] }],
  };
}

/** Long text-only assistant proposal (no tool call), as in "shall I apply this plan?". */
export const LONG_PROPOSAL = `Here is my plan: ${"first change the module, then migrate callers, then update the tests. ".repeat(40)}Shall I go ahead?`;

/** Anthropic body whose LAST user message has caller-chosen content blocks. */
export function anthropicRaw(messages: Body[], extra: Body = {}): Body {
  const base = anthropicBody("unused");
  return { ...base, messages, ...extra };
}

/** Responses body whose input is exactly the given items (plus the standard tools/instructions). */
export function codexRaw(input: Body[], extra: Body = {}): Body {
  const base = codexBody("unused");
  return { ...base, input, ...extra };
}

const DEBUG_SEED = "debug architecture refactor investigate security vulnerability";
const longHistory = (turns: number): Body[] =>
  Array.from({ length: turns }, (_, i) => [
    userMsg(`earlier request number ${i}`),
    assistantMsg(`earlier answer number ${i}`),
  ]).flat();

/** Representative request shapes: [label, body]. Order is stable; baseline is keyed by label. */
export const FIXTURE_TABLE: Array<[string, Body]> = [
  ["codex-ok-fresh-120tools", codexBody("ok")],
  [
    "codex-calendar-readonly-history",
    codexBody("whats on my calendar tomorrow", {
      history: [
        userMsg("check my calendar"),
        fnCall("mcp__calendar__list_events"),
        fnOutput("Meeting at 10am"),
        assistantMsg("You have a meeting at 10am."),
      ],
    }),
  ],
  ["codex-debug-crash", codexBody("debug why this crashes")],
  [
    "codex-ok-after-exec",
    codexBody("ok", {
      history: [
        userMsg("fix it"),
        fnCall("exec_command", '{"cmd":"git status"}'),
        fnOutput("clean"),
      ],
    }),
  ],
  [
    "codex-ok-after-unnamed-call",
    codexBody("ok", {
      history: [
        userMsg("do it"),
        { type: "function_call", arguments: "{}", call_id: "c" },
        fnOutput("x"),
      ],
    }),
  ],
  ["codex-four-user-turns", codexBody("ok", { history: longHistory(3) })],
  ["codex-long-ask-600", codexBody("please summarise the following notes ".repeat(17))],
  ["codex-effort-high", codexBody("ok", { effort: "high" })],
  ["codex-critical-keyword", codexBody("rotate the production credentials")],
  [
    "codex-huge-conversation",
    codexBody("ok", {
      history: [userMsg("here is a log"), assistantMsg("x".repeat(120_000))],
    }),
  ],
  ["codex-heavy-words-in-system-only", codexBody("ok", { instructionsSeed: DEBUG_SEED })],
  ["codex-few-tools-small", codexBody("hi", { tools: 3, instructionsChars: 500 })],
  ["codex-no-effort", codexBody("ok", { effort: null })],
  ["chat-hi-no-tools", { messages: [{ role: "user", content: "hi there" }], max_tokens: 100 }],
  ["chat-ok-40tools", chatBody("ok")],
  [
    "chat-ok-after-bash",
    chatBody("ok", {
      history: [
        { role: "user", content: "run it" },
        chatAssistantToolCall("bash"),
        { role: "tool", content: "done" },
      ],
    }),
  ],
  ["anthropic-ok-40tools", anthropicBody("ok")],
  [
    "anthropic-ok-after-edit",
    anthropicBody("ok", {
      history: [
        { role: "user", content: "edit it" },
        anthropicToolUse("Edit"),
        anthropicToolResult("done"),
      ],
    }),
  ],
  [
    "anthropic-search-readonly",
    anthropicBody("what is on my calendar tomorrow", {
      history: [
        { role: "user", content: "hello" },
        anthropicToolUse("calendar_search"),
        anthropicToolResult("10am"),
      ],
    }),
  ],
  ["gemini-short", geminiBody("what time is it in Tokyo")],
  ["string-input", { input: "ok", tools: codexTools(30) }],
  ["huge-output", codexBody("ok", { extra: { max_output_tokens: 40_000 } })],
  [
    "conflicting-output-limits",
    codexBody("ok", { extra: { max_tokens: 100, max_output_tokens: 200 } }),
  ],
  ["invalid-effort", codexBody("ok", { extra: { reasoning: { effort: "bogus" } } })],
  [
    "anthropic-slash-command-analyze",
    anthropicRaw([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      {
        role: "user",
        content:
          "<command-name>/init</command-name>\n<command-message>init</command-message>\n<command-args>analyze the whole codebase</command-args>",
      },
    ]),
  ],
  [
    "anthropic-reminder-then-delete-prod",
    anthropicRaw([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "<system-reminder>x</system-reminder> delete the production database",
          },
        ],
      },
    ]),
  ],
  [
    "codex-image-only-last-message",
    codexRaw([
      ENV_CONTEXT,
      userMsg("ok"),
      assistantMsg("hello"),
      {
        type: "message",
        role: "user",
        content: [{ type: "input_image", image_url: "data:image/png;base64,AAAA" }],
      },
    ]),
  ],
  [
    "anthropic-image-plus-short-text",
    anthropicRaw([
      {
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/png", data: "AAAA" } },
          { type: "text", text: "whats wrong here" },
        ],
      },
    ]),
  ],
  ["codex-previous-response-id", codexBody("ok", { extra: { previous_response_id: "resp_123" } })],
  [
    "codex-compaction-item",
    codexRaw([ENV_CONTEXT, { type: "compaction", encrypted_content: "gAAAA" }, userMsg("ok")]),
  ],
  [
    "codex-confirm-after-proposal",
    codexBody("ok", {
      history: [userMsg("refactor the auth module"), assistantMsg(LONG_PROPOSAL)],
    }),
  ],
  ["codex-non-ascii-cjk", codexBody("把认证重构一下")],
  ["codex-non-ascii-turkish", codexBody("testi düzelt")],
];
