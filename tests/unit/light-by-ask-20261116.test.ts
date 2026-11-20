/**
 * ROUTING_LIGHT_BY_ASK (2026-11-16): rate difficulty by the current ask, not by the tool
 * inventory. Design: _backups/plans/rate-by-the-ask-design-20261116.md
 *
 * Flag OFF: every fixture classifies exactly as the base build (b6136ba) did.
 * Flag ON: light only ever LOWERS a level; anything not clearly simple falls through.
 *
 * Tool-call rule table (documented here and in taskAwareRouting.ts):
 *   write/execute (blocks light): name matches exec|shell|bash|run|write|edit|patch|apply|
 *     delete|remove|create|update|send|commit|push|deploy, OR has a write/execute token
 *     (osascript, script, python, node, npm, git, terminal, command, sudo, kill, install,
 *     mkdir, mv, cp, rm, chmod, move, rename, add, set, put, post, save, insert, append,
 *     upload, submit, click, type), OR the call is unnamed/unrecognised.
 *   read-only (allowed): the name has a token read|get|list|search|find|view|cat|ls|fetch|
 *     query|calendar|grep|glob|stat|lookup|describe|show|pwd|whoami AND no write/execute match.
 */

import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";
import {
  classifyTask,
  classifyToolCallName,
  extractCurrentAsk,
  isLightByAskEnabled,
  scanPriorToolCalls,
  scoreModelForTask,
  type TaskClassification,
} from "../../open-sse/services/taskAwareRouting.ts";
import {
  FIXTURE_TABLE,
  anthropicBody,
  anthropicToolResult,
  anthropicToolUse,
  assistantMsg,
  chatAssistantToolCall,
  chatBody,
  codexBody,
  codexInstructions,
  codexTools,
  fnCall,
  fnOutput,
  geminiBody,
  userMsg,
  anthropicRaw,
  codexRaw,
  LONG_PROPOSAL,
  ENV_CONTEXT,
  type Body,
} from "./_fixtures/lightByAskFixtures.ts";

const FLAG = "ROUTING_LIGHT_BY_ASK";
const saved = process.env[FLAG];

function flagOn<T>(fn: () => T): T {
  process.env[FLAG] = "1";
  try {
    return fn();
  } finally {
    delete process.env[FLAG];
  }
}
function flagOff<T>(fn: () => T): T {
  delete process.env[FLAG];
  return fn();
}

afterEach(() => {
  if (saved === undefined) delete process.env[FLAG];
  else process.env[FLAG] = saved;
});

/** Captured from base b6136ba (flag-less code) on 2026-11-16 before any change. */
const BASELINE: Record<string, [string, string[]]> = {
  "codex-ok-fresh-120tools": ["critical", ["many-tools-large-context"]],
  "codex-calendar-readonly-history": ["critical", ["many-tools-large-context"]],
  "codex-debug-crash": ["critical", ["many-tools-large-context"]],
  "codex-ok-after-exec": ["critical", ["many-tools-large-context"]],
  "codex-ok-after-unnamed-call": ["critical", ["many-tools-large-context"]],
  "codex-four-user-turns": ["critical", ["many-tools-large-context"]],
  "codex-long-ask-600": ["critical", ["many-tools-large-context"]],
  "codex-effort-high": ["critical", ["many-tools-large-context"]],
  "codex-critical-keyword": ["critical", ["many-tools-large-context"]],
  "codex-huge-conversation": ["critical", ["huge-context"]],
  "codex-heavy-words-in-system-only": ["critical", ["many-tools-large-context"]],
  "codex-few-tools-small": ["standard", ["default"]],
  "codex-no-effort": ["critical", ["many-tools-large-context"]],
  "chat-hi-no-tools": ["light", ["small-simple-request"]],
  "chat-ok-40tools": ["critical", ["many-tools-large-context"]],
  "chat-ok-after-bash": ["critical", ["many-tools-large-context"]],
  "anthropic-ok-40tools": ["critical", ["many-tools-large-context"]],
  "anthropic-ok-after-edit": ["critical", ["many-tools-large-context"]],
  "anthropic-search-readonly": ["critical", ["many-tools-large-context"]],
  "gemini-short": ["standard", ["default"]],
  "string-input": ["standard", ["many-tools"]],
  "huge-output": ["critical", ["huge-output"]],
  "conflicting-output-limits": ["critical", ["many-tools-large-context"]],
  "invalid-effort": ["critical", ["many-tools-large-context"]],
  "anthropic-slash-command-analyze": ["critical", ["many-tools-large-context"]],
  "anthropic-reminder-then-delete-prod": ["critical", ["many-tools-large-context"]],
  "codex-image-only-last-message": ["critical", ["many-tools-large-context"]],
  "anthropic-image-plus-short-text": ["critical", ["many-tools-large-context"]],
  "codex-previous-response-id": ["critical", ["many-tools-large-context"]],
  "codex-compaction-item": ["critical", ["many-tools-large-context"]],
  "codex-confirm-after-proposal": ["critical", ["many-tools-large-context"]],
  "codex-non-ascii-cjk": ["critical", ["many-tools-large-context"]],
  "codex-non-ascii-turkish": ["critical", ["many-tools-large-context"]],
};

/** Labels that MUST be light with the flag on. */
const LIGHT_WHEN_ON = [
  "codex-ok-fresh-120tools",
  "codex-calendar-readonly-history",
  "codex-heavy-words-in-system-only",
  "codex-few-tools-small",
  "codex-no-effort",
  "chat-hi-no-tools",
  "chat-ok-40tools",
  "anthropic-ok-40tools",
  "anthropic-search-readonly",
  "gemini-short",
  "string-input",
];

const LEVEL_ORDER = ["light", "standard", "heavy", "critical"];

function lightByAsk(t: TaskClassification) {
  return t.level === "light" && t.reasons.includes("light-by-ask");
}

describe("flag OFF: identical to the base build", () => {
  it("flag defaults to off", () => {
    delete process.env[FLAG];
    assert.equal(isLightByAskEnabled(), false);
  });

  it("Codex 'ok' with 120 tools and 90k instructions is still critical / many-tools-large-context", () => {
    const t = flagOff(() => classifyTask(codexBody("ok")));
    assert.equal(t.level, "critical");
    assert.deepEqual(t.reasons, ["many-tools-large-context"]);
    assert.equal(t.toolCount, 120);
  });

  it("fixture table has a captured baseline for every label", () => {
    assert.deepEqual(Object.keys(BASELINE).sort(), FIXTURE_TABLE.map(([l]) => l).sort());
  });

  for (const [label, body] of FIXTURE_TABLE) {
    it(`baseline: ${label}`, () => {
      const t = flagOff(() => classifyTask(body));
      const [level, reasons] = BASELINE[label];
      assert.equal(t.level, level);
      assert.deepEqual(t.reasons, reasons);
    });
  }

  it("explicit falsy values keep it off", () => {
    for (const v of ["0", "false", "off", "", "no"]) {
      process.env[FLAG] = v;
      assert.equal(isLightByAskEnabled(), false, v);
      assert.equal(classifyTask(codexBody("ok")).level, "critical", v);
    }
  });
});

describe("flag ON: light by ask", () => {
  it("fresh-session 'ok' with 120 tools is light and auditable", () => {
    const t = flagOn(() => classifyTask(codexBody("ok")));
    assert.equal(t.level, "light");
    assert.equal(t.weight, 1);
    assert.equal(t.reasons[0], "light-by-ask");
    assert.ok(t.reasons.includes("ask-chars:2"), t.reasons.join());
    assert.ok(t.reasons.includes("user-turns:1"), t.reasons.join());
    assert.ok(t.reasons.includes("was:critical"), t.reasons.join());
    // signals are still spread like every other return
    assert.equal(t.toolCount, 120);
    assert.ok(t.promptChars > 90_000);
  });

  it("'whats on my calendar tomorrow' with only a prior read-only calendar call is light", () => {
    const body = codexBody("whats on my calendar tomorrow", {
      history: [
        userMsg("check my calendar"),
        fnCall("mcp__calendar__list_events"),
        fnOutput("Meeting at 10am"),
        assistantMsg("You have a meeting at 10am."),
      ],
    });
    const t = flagOn(() => classifyTask(body));
    assert.ok(lightByAsk(t), t.reasons.join());
    assert.ok(t.reasons.includes("user-turns:2"));
  });

  it("chat-completions and Anthropic shapes with read-only history are light", () => {
    const chat = chatBody("what is the weather", {
      history: [
        { role: "user", content: "hello" },
        chatAssistantToolCall("get_weather"),
        { role: "tool", content: "sunny" },
      ],
    });
    const anth = anthropicBody("what is the weather", {
      history: [
        { role: "user", content: "hello" },
        anthropicToolUse("web_search"),
        anthropicToolResult("sunny"),
      ],
    });
    const gem = geminiBody("what is the weather", [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ functionCall: { name: "get_weather", args: {} } }] },
      { role: "user", parts: [{ functionResponse: { name: "get_weather", response: {} } }] },
    ]);
    for (const body of [chat, anth, gem]) {
      const t = flagOn(() => classifyTask(body));
      assert.ok(lightByAsk(t), t.reasons.join());
    }
  });

  it("Anthropic tool_result-only user messages are not user turns", () => {
    const body = anthropicBody("ok", {
      history: [
        { role: "user", content: "hello" },
        anthropicToolUse("read_file"),
        anthropicToolResult("a"),
        anthropicToolUse("read_file"),
        anthropicToolResult("b"),
      ],
    });
    const { userTurns, ask } = extractCurrentAsk(body);
    assert.equal(userTurns, 2);
    assert.equal(ask, "ok");
  });

  it("injected scaffolding user items are not the ask and not user turns", () => {
    const body = codexBody("ok");
    (body.input as Body[]).push(userMsg("<system-reminder>be careful</system-reminder>"));
    (body.input as Body[]).unshift(userMsg("# AGENTS.md instructions for /x\n\nrules"));
    const { userTurns, ask } = extractCurrentAsk(body);
    assert.equal(ask, "ok");
    assert.equal(userTurns, 1);
  });

  it("exactly 3 user turns is still light (non-confirmation ask)", () => {
    const history = [userMsg("a"), assistantMsg("b"), userMsg("c"), assistantMsg("d")];
    const t = flagOn(() => classifyTask(codexBody("thanks", { history })));
    assert.ok(lightByAsk(t), t.reasons.join());
    assert.ok(t.reasons.includes("user-turns:3"));
  });

  it("a heavy keyword only in the SYSTEM prompt does not block light (the point)", () => {
    const body = codexBody("ok", {
      instructionsSeed: "debug architecture refactor investigate security vulnerability exploit",
    });
    assert.equal(
      flagOff(() => classifyTask(body)).level,
      "critical",
      "baseline: the system prompt keywords are in the whole-text regexes"
    );
    assert.ok(lightByAsk(flagOn(() => classifyTask(body))));
  });

  it("a heavy keyword only in earlier history (not the current ask) does not block light", () => {
    const body = codexBody("thanks", {
      history: [userMsg("debug the architecture"), assistantMsg("done, it was a typo")],
    });
    assert.ok(lightByAsk(flagOn(() => classifyTask(body))));
  });

  it("tool inventory size alone never prevents light (0, 8, 120 tools)", () => {
    for (const tools of [0, 8, 120]) {
      const t = flagOn(() => classifyTask(codexBody("ok", { tools })));
      assert.equal(t.level, "light", `tools=${tools}`);
    }
  });

  it("already-light requests are returned untouched (no relabel)", () => {
    const body = { messages: [{ role: "user", content: "hi there" }], max_tokens: 100 };
    const off = flagOff(() => classifyTask(body));
    const on = flagOn(() => classifyTask(body));
    assert.deepEqual(on, off);
  });
});

describe("flag ON: NOT light", () => {
  const notLight = (label: string, body: Body, expectLevel?: string) => {
    it(label, () => {
      const on = flagOn(() => classifyTask(body));
      const off = flagOff(() => classifyTask(body));
      assert.notEqual(on.level, "light", on.reasons.join());
      assert.ok(!on.reasons.includes("light-by-ask"));
      assert.equal(on.level, off.level);
      assert.deepEqual(on.reasons, off.reasons);
      if (expectLevel) assert.equal(on.level, expectLevel);
    });
  };

  notLight(
    "'debug why this crashes' (heavy keyword in the ask)",
    codexBody("debug why this crashes"),
    "critical"
  );
  notLight(
    "'ok' after an assistant exec_command call",
    codexBody("ok", {
      history: [userMsg("fix it"), fnCall("exec_command", '{"cmd":"ls"}'), fnOutput("x")],
    })
  );
  notLight(
    "'ok' after an apply_patch call",
    codexBody("ok", { history: [userMsg("fix it"), fnCall("apply_patch"), fnOutput("x")] })
  );
  notLight(
    "'ok' after a local_shell_call item",
    codexBody("ok", {
      history: [
        userMsg("go"),
        { type: "local_shell_call", call_id: "x", action: { type: "exec" } },
      ],
    })
  );
  notLight(
    "'ok' after an UNNAMED function_call",
    codexBody("ok", {
      history: [
        userMsg("go"),
        { type: "function_call", arguments: "{}", call_id: "c" },
        fnOutput("x"),
      ],
    })
  );
  notLight(
    "'ok' after an UNKNOWN-named tool call (not on the read-only list)",
    codexBody("ok", { history: [userMsg("go"), fnCall("frobnicate"), fnOutput("x")] })
  );
  notLight(
    "'ok' after an osascript tool call (execute-capable)",
    codexBody("ok", { history: [userMsg("go"), fnCall("osascript"), fnOutput("x")] })
  );
  notLight(
    "chat: 'ok' after a bash tool_call",
    chatBody("ok", {
      history: [
        { role: "user", content: "run it" },
        chatAssistantToolCall("bash"),
        { role: "tool", content: "d" },
      ],
    })
  );
  notLight(
    "chat: 'ok' after an unnamed tool_call",
    chatBody("ok", {
      history: [
        { role: "user", content: "x" },
        {
          role: "assistant",
          content: null,
          tool_calls: [{ id: "c", type: "function", function: {} }],
        },
      ],
    })
  );
  notLight(
    "anthropic: 'ok' after an Edit tool_use",
    anthropicBody("ok", {
      history: [
        { role: "user", content: "edit it" },
        anthropicToolUse("Edit"),
        anthropicToolResult("d"),
      ],
    })
  );
  notLight(
    "gemini: 'ok' after a functionCall to a write tool",
    geminiBody("ok", [
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ functionCall: { name: "send_email", args: {} } }] },
    ])
  );
  notLight(
    "4 user turns",
    codexBody("ok", {
      history: [
        userMsg("a"),
        assistantMsg("b"),
        userMsg("c"),
        assistantMsg("d"),
        userMsg("e"),
        assistantMsg("f"),
      ],
    })
  );
  notLight("ask of 600 chars", codexBody("please summarise the following notes ".repeat(17)));
  notLight("ask of exactly 401 chars", codexBody("a".repeat(401)));
  notLight("effort high", codexBody("ok", { effort: "high" }));
  notLight("effort xhigh", codexBody("ok", { effort: "xhigh" }));
  notLight(
    "effort max (Anthropic output_config)",
    anthropicBody("ok", { extra: { output_config: { effort: "max" } } })
  );
  notLight(
    "large thinking budget",
    anthropicBody("ok", { extra: { thinking: { type: "enabled", budget_tokens: 16000 } } })
  );
  notLight(
    "critical keyword in the ask ('rotate the production credentials')",
    codexBody("rotate the production credentials"),
    "critical"
  );
  notLight(
    "critical regex keyword in the ask ('security')",
    codexBody("is there a security issue")
  );
  notLight("complex-operation cue in the ask ('analyze this')", codexBody("analyze this"));
  notLight(
    "mutating verb in the ask ('delete the old branch')",
    codexBody("delete the old branch")
  );
  notLight(
    "huge conversation (>=100k chars of real message text)",
    codexBody("ok", { history: [userMsg("here is a log"), assistantMsg("x".repeat(120_000))] }),
    "critical"
  );
  notLight("huge output limit", codexBody("ok", { extra: { max_output_tokens: 40_000 } }));
  notLight("large output limit (>= 8192)", codexBody("ok", { extra: { max_output_tokens: 9000 } }));
  notLight(
    "conflicting output limits",
    codexBody("ok", { extra: { max_tokens: 100, max_output_tokens: 200 } })
  );
  notLight("invalid output limit", codexBody("ok", { extra: { max_output_tokens: -5 } }));
  notLight(
    "invalid reasoning control",
    codexBody("ok", { extra: { reasoning: { effort: "bogus" } } })
  );
  notLight(
    "conflicting reasoning controls",
    codexBody("ok", { extra: { reasoning: { effort: "low" }, reasoning_effort: "high" } })
  );
  notLight("conflicting message dialects (messages + input)", {
    ...codexBody("ok"),
    messages: [{ role: "user", content: "ok" }],
  });
  notLight("empty ask", {
    instructions: codexInstructions(),
    input: [ENV_ONLY()],
    tools: codexTools(),
  });
  notLight("no user message at all", {
    instructions: codexInstructions(),
    input: [assistantMsg("hello")],
    tools: codexTools(),
  });
});

function ENV_ONLY(): Body {
  return userMsg("<environment_context>\n<cwd>/x</cwd>\n</environment_context>");
}

describe("flag ON: never raises", () => {
  it("for every fixture, flag-on level is never higher than flag-off level", () => {
    for (const [label, body] of FIXTURE_TABLE) {
      const off = flagOff(() => classifyTask(body));
      const on = flagOn(() => classifyTask(body));
      assert.ok(
        LEVEL_ORDER.indexOf(on.level) <= LEVEL_ORDER.indexOf(off.level),
        `${label}: ${off.level} -> ${on.level}`
      );
      if (on.level !== "light" || off.level === "light") {
        assert.equal(on.level, off.level, label);
        assert.deepEqual(on.reasons, off.reasons, label);
      }
    }
  });

  it("fixtures expected to be light are light, all others are unchanged", () => {
    for (const [label, body] of FIXTURE_TABLE) {
      const on = flagOn(() => classifyTask(body));
      const off = flagOff(() => classifyTask(body));
      if (LIGHT_WHEN_ON.includes(label)) assert.equal(on.level, "light", label);
      else assert.equal(on.level, off.level, label);
    }
  });

  it("garbage bodies never throw", () => {
    for (const body of [
      undefined,
      null,
      {},
      { input: 5 },
      { messages: "x" },
      { input: [null, 1, "x"] },
    ]) {
      flagOn(() => classifyTask(body as unknown as Body));
    }
  });
});

describe("tool-name rule table", () => {
  const write = [
    "exec_command",
    "shell",
    "bash",
    "Bash",
    "run_tests",
    "write_file",
    "Edit",
    "apply_patch",
    "delete_event",
    "remove",
    "create_event",
    "update_row",
    "send_message",
    "git_commit",
    "git_push",
    "deploy",
    "osascript",
    "python",
    "execute_code",
    "mcp__x__frobnicate",
    "",
    undefined,
    null,
    42,
  ];
  const read = [
    "read_file",
    "get_weather",
    "list_events",
    "web_search",
    "find",
    "view_image",
    "cat",
    "ls",
    "fetch_url",
    "query_db",
    "mcp__calendar__list_events",
    "calendar_search",
    "grep",
    "glob",
  ];
  for (const n of write) {
    it(`write/execute: ${JSON.stringify(n)}`, () =>
      assert.equal(classifyToolCallName(n), "write-or-execute"));
  }
  for (const n of read) {
    it(`read-only: ${n}`, () => assert.equal(classifyToolCallName(n), "read"));
  }

  it("scanPriorToolCalls counts both kinds across wire formats", () => {
    const body = codexBody("ok", {
      history: [
        fnCall("list_events"),
        { type: "web_search_call", status: "completed" },
        fnCall("exec_command"),
      ],
    });
    assert.deepEqual(scanPriorToolCalls(body), { readOnly: 2, writeOrExecute: 1 });
  });
});

describe("selector regression: ranking follows verified capability, not model names", () => {
  // Changed 2026-11-20. This block used to assert "light prefers small/mid Claude, critical
  // prefers Opus", which held only because the power score added points for words like opus,
  // haiku and sonnet in the id. The score is now name-blind: sufficiency against the task level.
  const OPUS = "claude/claude-opus-4-8";
  const SMALLER = ["claude/claude-sonnet-5", "claude/claude-haiku-4-5-20251001"];

  it("light classification: smaller models are not ranked below opus-4-8", () => {
    const light = flagOn(() => classifyTask(codexBody("ok")));
    assert.equal(light.level, "light");
    for (const m of SMALLER) {
      assert.ok(scoreModelForTask(m, light) >= scoreModelForTask(OPUS, light), m);
    }
  });

  it("critical classification (flag off): opus-4-8 is not ranked below sonnet-5 or haiku-4-5", () => {
    const critical = flagOff(() => classifyTask(codexBody("ok")));
    assert.equal(critical.level, "critical");
    for (const m of SMALLER) {
      assert.ok(scoreModelForTask(OPUS, critical) >= scoreModelForTask(m, critical), m);
    }
  });

  it("a critical prompt that does not fit haiku-4-5's verified window ranks opus-4-8 above it", () => {
    const t = flagOff(() => classifyTask(codexBody("ok")));
    const big = { ...t, promptChars: 4 * 600_000 };
    assert.ok(
      scoreModelForTask(OPUS, big) > scoreModelForTask("claude/claude-haiku-4-5-20251001", big)
    );
  });

  it("a heavy ask never ranks opus-4-8 below the smaller models with the flag on", () => {
    const t = flagOn(() => classifyTask(codexBody("debug why this crashes")));
    assert.equal(t.level, "critical");
    for (const m of SMALLER) assert.ok(scoreModelForTask(OPUS, t) >= scoreModelForTask(m, t), m);
  });
});

// ───────────────────────── fix round 2026-11-16 (Reviewer: MERGE AFTER FIXES) ─────────────────────────

function expectNotLight(body: Body, why: string) {
  const on = flagOn(() => classifyTask(body));
  const off = flagOff(() => classifyTask(body));
  assert.notEqual(on.level, "light", `${why}: ${on.reasons.join()}`);
  assert.equal(on.level, off.level, why);
}
function expectLight(body: Body, why: string) {
  const on = flagOn(() => classifyTask(body));
  assert.ok(lightByAsk(on), `${why}: ${on.level} ${on.reasons.join()}`);
}

describe("item 1: stale ask / dropped last message", () => {
  it("a slash command is a real ask, not scaffolding (<command-args>analyze ...)", () => {
    expectNotLight(
      anthropicRaw([
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
        {
          role: "user",
          content:
            "<command-name>/init</command-name>\n<command-message>init</command-message>\n<command-args>analyze the whole codebase</command-args>",
        },
      ]),
      "slash command"
    );
  });

  it("text AFTER a closed system-reminder wrapper is kept as the ask", () => {
    const body = anthropicRaw([
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
    ]);
    assert.equal(extractCurrentAsk(body).ask, "delete the production database");
    expectNotLight(body, "reminder then delete");
  });

  it("two stacked closed wrappers then text keeps only the text", () => {
    const body = codexRaw([
      userMsg(
        "<environment_context>\n<cwd>/x</cwd>\n</environment_context><system-reminder>y</system-reminder> ok"
      ),
    ]);
    assert.equal(extractCurrentAsk(body).ask, "ok");
  });

  it("a pure scaffolding block (closed or unclosed) still yields no ask text", () => {
    assert.equal(extractCurrentAsk(codexRaw([ENV_CONTEXT])).userTurns, 0);
    assert.equal(
      extractCurrentAsk(
        codexRaw([userMsg("# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>rules</INSTRUCTIONS>")])
      ).userTurns,
      0
    );
  });

  it("last user message that is only an image / file is NOT light (no stale earlier ask)", () => {
    const shapes: Array<[string, Body]> = [
      [
        "responses input_image",
        codexRaw([
          ENV_CONTEXT,
          userMsg("ok"),
          assistantMsg("hi"),
          {
            type: "message",
            role: "user",
            content: [{ type: "input_image", image_url: "data:image/png;base64,AA" }],
          },
        ]),
      ],
      [
        "responses input_file",
        codexRaw([
          ENV_CONTEXT,
          userMsg("ok"),
          assistantMsg("hi"),
          { type: "message", role: "user", content: [{ type: "input_file", file_id: "file_1" }] },
        ]),
      ],
      [
        "anthropic image",
        anthropicRaw([
          { role: "user", content: "ok" },
          { role: "assistant", content: "hi" },
          {
            role: "user",
            content: [
              { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
            ],
          },
        ]),
      ],
      [
        "anthropic document",
        anthropicRaw([
          { role: "user", content: "ok" },
          { role: "assistant", content: "hi" },
          {
            role: "user",
            content: [
              {
                type: "document",
                source: { type: "base64", media_type: "application/pdf", data: "AA" },
              },
            ],
          },
        ]),
      ],
      [
        "gemini inlineData",
        {
          contents: [
            { role: "user", parts: [{ text: "ok" }] },
            { role: "model", parts: [{ text: "hi" }] },
            { role: "user", parts: [{ inlineData: { mimeType: "image/png", data: "AA" } }] },
          ],
          tools: [{ functionDeclarations: [{ name: "x" }] }],
          instructions: "z".repeat(120_000),
        },
      ],
    ];
    for (const [why, body] of shapes) {
      const { ask, userTurns } = extractCurrentAsk(body);
      assert.equal(ask, "", `${why}: ask must be empty, not the stale earlier text`);
      assert.equal(userTurns, 2, why);
      const on = flagOn(() => classifyTask(body));
      assert.notEqual(on.level, "light", `${why}: ${on.reasons.join()}`);
    }
  });

  it("image PLUS a short text is NOT light (the image carries the question)", () => {
    expectNotLight(
      anthropicRaw([
        {
          role: "user",
          content: [
            { type: "image", source: { type: "base64", media_type: "image/png", data: "AA" } },
            { type: "text", text: "whats wrong here" },
          ],
        },
      ]),
      "anthropic image+text"
    );
    expectNotLight(
      codexRaw([
        ENV_CONTEXT,
        {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "what is this" },
            { type: "input_image", image_url: "data:image/png;base64,AA" },
          ],
        },
      ]),
      "responses image+text"
    );
  });

  it("tool_result-only user messages remain non-turns (not an empty-text turn)", () => {
    const body = anthropicRaw([
      { role: "user", content: "hello" },
      anthropicToolUse("read_file"),
      anthropicToolResult("a"),
    ]);
    const { ask, userTurns } = extractCurrentAsk(body);
    assert.equal(userTurns, 1);
    assert.equal(ask, "hello");
  });
});

describe("item 2: hidden history", () => {
  const cases: Array<[string, Body]> = [
    ["previous_response_id", codexBody("ok", { extra: { previous_response_id: "resp_1" } })],
    ["conversation", codexBody("ok", { extra: { conversation: { id: "conv_1" } } })],
    ["container", codexBody("ok", { extra: { container: "cntr_1" } })],
    [
      "compaction item",
      codexRaw([ENV_CONTEXT, { type: "compaction", encrypted_content: "gA" }, userMsg("ok")]),
    ],
    [
      "summary-handoff user text",
      codexRaw([
        ENV_CONTEXT,
        userMsg(
          "Another language model started to solve this problem and produced a summary of its thinking process."
        ),
        userMsg("ok"),
      ]),
    ],
  ];
  for (const [why, body] of cases) {
    it(`${why} => not light`, () => expectNotLight(body, why));
  }
  it("without any hidden-history marker the same 'ok' is light", () => {
    expectLight(codexBody("ok"), "plain");
  });
});

describe("item 3: confirmations after a proposal", () => {
  const PHRASES = [
    "ok",
    "okay",
    "yes",
    "yep",
    "yeah",
    "sure",
    "y",
    "go ahead",
    "do it",
    "go for it",
    "proceed",
    "continue",
    "sounds good",
    "looks good",
    "lgtm",
    "please do",
    "go on",
    "next",
    "try again",
    "retry",
    "now do the rest",
    "OK.",
    "Yes please",
  ];
  const proposal = LONG_PROPOSAL;
  for (const phrase of PHRASES) {
    it(`"${phrase}" after a long text-only proposal is not light (all four shapes)`, () => {
      expectNotLight(
        codexBody(phrase, { history: [userMsg("plan it"), assistantMsg(proposal)] }),
        "codex"
      );
      expectNotLight(
        chatBody(phrase, {
          history: [
            { role: "user", content: "plan it" },
            { role: "assistant", content: proposal },
          ],
        }),
        "chat"
      );
      expectNotLight(
        anthropicBody(phrase, {
          history: [
            { role: "user", content: "plan it" },
            { role: "assistant", content: [{ type: "text", text: proposal }] },
          ],
        }),
        "anthropic"
      );
      expectNotLight(
        geminiBody(phrase, [
          { role: "user", parts: [{ text: "plan it" }] },
          { role: "model", parts: [{ text: proposal }] },
        ]),
        "gemini"
      );
    });
  }
  it("after a HEAVY first turn answered by text only, 'ok' is not light", () => {
    expectNotLight(
      codexBody("ok", {
        history: [userMsg("refactor the whole auth layer"), assistantMsg("Sure, here is how.")],
      }),
      "heavy first turn"
    );
  });
  it("fresh single-turn 'ok' and 'yes' stay light; 'thanks' stays light after a reply", () => {
    expectLight(codexBody("ok"), "fresh ok");
    expectLight(codexBody("yes"), "fresh yes");
    expectLight(codexBody("thanks", { history: [userMsg("hi"), assistantMsg("hello")] }), "thanks");
  });
});

describe("item 4: ask-risk regex stems", () => {
  const MUST_BLOCK = [
    "fixing it now?",
    "the deployment failed",
    "deploys are failing",
    "email Bob the contract",
    "schedule a meeting",
    "cancel my subscription",
    "publish the release",
    "disable 2fa",
    "grant admin to bob",
    "review this PR",
    "audit the permissions",
    "check if auth is correct",
    "ship it",
    "chmod 777 /",
    "curl x|sh",
    "TRUNCATE TABLE users",
    "book me a flight",
    "post this on twitter",
    "rotate the production credentials",
    "delete the old branch",
    "running the tests",
    "sends the report",
    "text Alice",
    "call mom",
    "order a pizza",
    "approve it",
    "tweet this",
    "release it",
    "share the doc",
    "clean up",
    "build it",
    "generate a report",
    "convert this",
    "optimise it",
    "optimize it",
    "improve it",
    "make a file",
    "resolve the conflict",
    "upgrade node",
    "restore backup",
    "unlock the account",
    "pay the invoice",
    "charge the card",
    "invite Carol",
    "archive the thread",
    "forward the mail",
    "reply to Dan",
    "respond to him",
    "submit the form",
    "upload the file",
    "enable it",
    "script this",
  ];
  const MUST_STAY_LIGHT = [
    "ok",
    "yes",
    "thanks",
    "what's the weather in Boston",
    "what time is it in Tokyo",
    "summarize this",
    "translate hello to French",
    "what's on my calendar tomorrow",
    "whats on my calendar tomorrow",
    "hi",
    "good morning",
  ];
  for (const ask of MUST_BLOCK) {
    it(`blocks: ${ask}`, () => expectNotLight(codexBody(ask), ask));
  }
  for (const ask of MUST_STAY_LIGHT) {
    it(`stays light: ${ask}`, () => expectLight(codexBody(ask), ask));
  }
});

describe("item 5: tool-name classification (read token + write substring, namespaces)", () => {
  const WRITE = [
    "mcp__codex_apps__calendar_create_event",
    "github_create_issue",
    "gmail_send_message",
    "calendar_create_event",
    "calendar_respond_to_event",
    "calendar_accept_invite",
    "calendar_cancel_event",
    "calendar_decline",
    "calendar_schedule_meeting",
    "calendar_invite",
    "calendar_reschedule",
    "gmail_search_and_archive",
    "drive_get_and_share",
    "github_list_merge",
    "view_and_approve",
    "fetch_and_pay",
    "get_and_trash",
    "list_and_label",
    "read_and_publish",
    "get_and_forward",
    "get_and_reply",
    "list_and_close",
    "query_and_transition",
    "get_and_trigger",
    "get_and_dispatch",
    "get_and_invoke",
    "get_and_ban",
    "get_and_kick",
    "get_and_disable",
    "get_and_enable",
    "get_and_unlock",
    "get_and_provision",
    "get_and_mark",
    "get_and_book",
    "get_and_order",
    "get_and_charge",
  ];
  const READ = [
    "calendar_search_events",
    "calendar_list_events",
    "list_calendars",
    "read_file",
    "search_files",
    "get_weather",
    "web_search",
  ];
  for (const n of WRITE)
    it(`write: ${n}`, () => assert.equal(classifyToolCallName(n), "write-or-execute"));
  for (const n of READ) it(`read: ${n}`, () => assert.equal(classifyToolCallName(n), "read"));
  it("a bare 'calendar' token is no longer a read signal", () => {
    assert.equal(classifyToolCallName("calendar"), "write-or-execute");
    assert.equal(classifyToolCallName("calendar_tool"), "write-or-execute");
  });
  it("namespace / server_label are part of the classified identity", () => {
    const call = (extra: Body) =>
      scanPriorToolCalls(
        codexBody("ok", {
          history: [{ type: "function_call", call_id: "c", arguments: "{}", ...extra }],
        })
      );
    assert.deepEqual(call({ name: "list", namespace: "mcp__codex_apps__calendar_create_event" }), {
      readOnly: 0,
      writeOrExecute: 1,
    });
    assert.deepEqual(call({ type: "mcp_call", name: "list", server_label: "gmail_send_message" }), {
      readOnly: 0,
      writeOrExecute: 1,
    });
    assert.deepEqual(call({ name: "list", namespace: "mcp__codex_apps__calendar" }), {
      readOnly: 1,
      writeOrExecute: 0,
    });
    assert.deepEqual(call({ name: "list_events" }), { readOnly: 1, writeOrExecute: 0 });
    assert.deepEqual(call({}), { readOnly: 0, writeOrExecute: 1 });
  });
  it("'ok' after a namespaced write call hidden behind a read-looking name is not light", () => {
    expectNotLight(
      codexBody("ok", {
        history: [
          userMsg("go"),
          {
            type: "function_call",
            name: "list",
            namespace: "mcp__codex_apps__calendar_create_event",
            arguments: "{}",
            call_id: "c",
          },
          fnOutput("x"),
        ],
      }),
      "namespace write"
    );
  });
});

describe("item 7: non-English asks are not light (lexicon is English only)", () => {
  for (const ask of ["把认证重构一下", "本番が落ちている", "исправь тест", "testi düzelt"]) {
    it(`not light: ${ask}`, () => expectNotLight(codexBody(ask), ask));
  }
  it("known limit: an ASCII non-English ask ('arregla el test inestable') is still light", () => {
    expectLight(codexBody("arregla el test inestable"), "ascii spanish");
  });
});

describe("item 9: extra coverage from the mutation run", () => {
  it("read token + write substring is write (calendar_create_event, gmail_send_message)", () => {
    assert.equal(classifyToolCallName("calendar_create_event"), "write-or-execute");
    assert.equal(classifyToolCallName("gmail_send_message"), "write-or-execute");
  });

  it("legacy chat function_call is scanned (write blocks light, read allowed)", () => {
    const legacy = (name: string): Body => ({
      role: "assistant",
      content: null,
      function_call: { name, arguments: "{}" },
    });
    assert.deepEqual(scanPriorToolCalls(chatBody("ok", { history: [legacy("bash")] })), {
      readOnly: 0,
      writeOrExecute: 1,
    });
    assert.deepEqual(scanPriorToolCalls(chatBody("ok", { history: [legacy("get_weather")] })), {
      readOnly: 1,
      writeOrExecute: 0,
    });
    expectNotLight(
      chatBody("ok", { history: [{ role: "user", content: "x" }, legacy("bash")] }),
      "legacy bash"
    );
  });

  it("Gemini executableCode part counts as execute", () => {
    const body = geminiBody("ok", [
      { role: "user", parts: [{ text: "x" }] },
      { role: "model", parts: [{ executableCode: { language: "PYTHON", code: "print(1)" } }] },
    ]);
    assert.deepEqual(scanPriorToolCalls(body), { readOnly: 0, writeOrExecute: 1 });
    expectNotLight(
      { ...body, instructions: "z".repeat(120_000), tools: codexBody("x").tools },
      "executableCode"
    );
  });

  it("unmeasurable conversation size (BigInt field) is not light", () => {
    const body = codexBody("ok");
    (body.input as Body[]).push({ type: "message", role: "assistant", content: [], size: 10n });
    expectNotLight(body, "bigint");
  });

  it("a heavy keyword in the MIDDLE of an ask blocks light", () => {
    expectNotLight(codexBody("so why not investigate the crash"), "investigate");
    expectNotLight(codexBody("can you please debug this"), "debug");
  });

  it("stale-ask guard: earlier benign ask never becomes the ask when the last message is not text", () => {
    const body = codexRaw([
      ENV_CONTEXT,
      userMsg("thanks"),
      assistantMsg("hi"),
      { type: "message", role: "user", content: [{ type: "input_file", file_id: "f" }] },
    ]);
    assert.equal(extractCurrentAsk(body).ask, "");
    expectNotLight(body, "file-only last");
  });
});
