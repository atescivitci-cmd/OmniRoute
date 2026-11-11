import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {
  prepareLocalArchiveRequest,
  bindLocalArchiveToolIdentity,
} from "../../open-sse/services/localArchiveRequest.ts";
import {
  ArchiveStore,
  partition,
  prepareResidentContinuation,
  prepareLocalContinuation,
  continuationFailure,
} from "../../open-sse/services/localArchiveContinuation.mjs";
import { createBodyTokenCounter } from "../../open-sse/services/localTokenBudget.mjs";
import { buildNativeRequest } from "../../open-sse/services/localFinalFallback.mjs";
import { openaiResponsesToOpenAIRequest } from "../../open-sse/translator/request/openai-responses.ts";
import { collectCustomToolNamesForSourceFormat } from "../../open-sse/translator/request/openai-responses/additionalTools.ts";

const capacity = Object.freeze({
  model: "qwen3.6:35b-a3b",
  digest: "07d35212591fc27746f0a317c975a6d68754fb38e9053d82e25f06057af28522",
  context: 65536,
  origin: "http://127.0.0.1:11434",
});
const modelPath = "/Users/atescivitci/.ollama/models/blobs/sha256-f5ee307a2982106a6eb82b62b2c00b575c9072145a759ae4660378acda8dcf2d";
const syntheticHeaders = () => new Headers({
  authorization: "Bearer SYNTHETIC_FIXTURE_ONLY",
  "x-session-id": "synthetic-responses-session",
});
const fixture = () => ({
  model: "ac-terminal-continuity",
  instructions: "Mandatory synthetic instructions remain intact.",
  input: [
    { type: "message", role: "user", content: [{ type: "input_text", text: "Synthetic task" }] },
    { type: "function_call", call_id: "call_1", name: "lookup", arguments: '{"key":"fixture"}' },
    { type: "function_call_output", call_id: "call_1", output: "Synthetic result" },
  ],
  tools: [{ type: "function", name: "lookup", description: "Synthetic lookup", parameters: { type: "object", properties: { key: { type: "string" } }, required: ["key"] } }],
  max_output_tokens: 16,
  reasoning: { effort: "medium" },
});
function scratch(t: any) {
  const parent = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "responses-admission-fixture-"));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  return path.join(parent, "archive");
}
function metadataFetcher(calls: string[], models = [{ name: capacity.model, digest: capacity.digest, context_length: capacity.context }]) {
  return async (url: string, init: any) => {
    calls.push(url);
    assert.equal(url, capacity.origin + "/api/ps");
    assert.equal(init.method, "GET");
    assert.equal(init.cache, "no-store");
    return Response.json({ models });
  };
}
function syntheticExecutor(calls: string[]) {
  return (file: string, args: string[], options: any) => {
    if (file.endsWith("/lsof")) { calls.push("listener"); return "123\n"; }
    if (file.endsWith("/ps")) { calls.push("owner"); return `${process.getuid()} 456 123 runner --model ${modelPath} --host 127.0.0.1 --port 56789\n`; }
    if (file.endsWith("/python")) {
      calls.push("render");
      const rendered = JSON.parse(options.input);
      assert.ok(Array.isArray(rendered.messages));
      assert.ok(rendered.messages.every((m: any) => typeof m.role === "string"));
      return JSON.stringify({ prompt: "synthetic rendered prompt" });
    }
    if (file.endsWith("/curl") && args.at(-1)?.endsWith("/props")) { calls.push("props"); return JSON.stringify({ model_path: modelPath }); }
    if (file.endsWith("/curl") && args.at(-1)?.endsWith("/tokenize")) { calls.push("tokenize"); return JSON.stringify({ tokens: [1, 2, 3] }); }
    throw new Error("unqualified fixture transport");
  };
}

test("baseline input-only Responses body reproduces misleading identity503 before renderer", () => {
  const calls: string[] = [];
  const counter = createBodyTokenCounter(capacity, buildNativeRequest, { execute: syntheticExecutor(calls) });
  assert.throws(() => counter(fixture()), (error: any) => {
    assert.equal(error.code, "local_context_unavailable");
    assert.equal(error.status, 503);
    assert.equal(error.details.reason, "local_identity_unverified");
    return true;
  });
  assert.deepEqual(calls, ["listener", "owner", "props"]);
});

test("canonical normalization admits Responses layout into the unchanged exact counter with fake transport", () => {
  const calls: string[] = [];
  const source = fixture();
  const before = structuredClone(source);
  const prepared = prepareLocalArchiveRequest(source);
  const counter = createBodyTokenCounter(capacity, buildNativeRequest, { execute: syntheticExecutor(calls) });
  assert.equal(counter(prepared.body), 3);
  assert.deepEqual(source, before);
  assert.deepEqual(prepared.originalBody, before);
  assert.deepEqual(calls, ["listener", "owner", "props", "render", "listener", "owner", "props", "tokenize"]);
});

test("normalization preserves mandatory text, schema and complete function call/result pairing", () => {
  const original = fixture();
  const normalized = prepareLocalArchiveRequest(original).body;
  assert.equal(normalized.input, undefined);
  assert.equal(normalized.instructions, undefined);
  assert.deepEqual(normalized.messages[0], { role: "system", content: original.instructions });
  assert.equal(normalized.messages[2].tool_calls[0].id, "call_1");
  assert.equal(normalized.messages[2].tool_calls[0].function.arguments, '{"key":"fixture"}');
  assert.equal(normalized.messages[3].tool_call_id, "call_1");
  assert.equal(normalized.messages[3].content, "Synthetic result");
  assert.deepEqual(normalized.tools[0].function.parameters, original.tools[0].parameters);
  assert.equal(normalized.model, original.model);
  assert.equal(normalized.max_output_tokens, 16);
  assert.equal(partition(normalized.messages).groups.length, 1);
});

test("native translation preserves full mandatory input and uses admitted capacity/model", () => {
  const normalized = prepareLocalArchiveRequest(fixture()).body;
  const native = buildNativeRequest({ stream: false }, { ...normalized, max_tokens: 16, reasoning_effort: "none" }, capacity);
  assert.equal(native.model, capacity.model);
  assert.equal(native.options.num_ctx, capacity.context);
  assert.equal(native.options.num_predict, 16);
  assert.equal(native.think, false);
  assert.equal(native.truncate, false);
  assert.equal(native.shift, false);
  assert.equal(native.messages[0].content, fixture().instructions);
  assert.deepEqual(native.messages[2].tool_calls[0].function.arguments, { key: "fixture" });
});

test("normalization does not double translate already-normalized messages or ordinary chat", () => {
  const once = prepareLocalArchiveRequest(fixture());
  const twice = prepareLocalArchiveRequest(once.body);
  assert.equal(twice.body, once.body);
  assert.equal(twice.originalBody, undefined);
  assert.equal(openaiResponsesToOpenAIRequest("ollama-local", twice.body, false, null), twice.body);
  const ordinary = { messages: [{ role: "user", content: "Synthetic ordinary chat" }], max_tokens: 16 };
  assert.equal(prepareLocalArchiveRequest(ordinary).body, ordinary);
});

test("custom tool schema, raw input and result remain represented with original response identity", () => {
  const source = fixture() as any;
  source.tools = [{ type: "custom", name: "apply_fixture", format: { type: "text" } }];
  source.input = [source.input[0], { type: "custom_tool_call", call_id: "custom_1", name: "apply_fixture", input: "synthetic raw patch" }, { type: "custom_tool_call_output", call_id: "custom_1", output: "synthetic success" }];
  const prepared = prepareLocalArchiveRequest(source);
  assert.deepEqual(JSON.parse(prepared.body.messages[2].tool_calls[0].function.arguments), { input: "synthetic raw patch" });
  assert.equal(prepared.body.messages[3].tool_call_id, "custom_1");
  assert.deepEqual([...collectCustomToolNamesForSourceFormat("openai-responses", "openai-responses", prepared.originalBody.tools, prepared.originalBody.input)], ["apply_fixture"]);
  assert.deepEqual(prepared.originalBody, source);
});

test("namespace tool response map survives planner cloning and stays out of native wire", () => {
  const source = fixture() as any;
  source.tools = [{ type: "namespace", name: "fixture_ns", tools: [{ type: "function", name: "lookup", parameters: { type: "object", properties: {} } }] }];
  const prepared = prepareLocalArchiveRequest(source);
  assert.ok(prepared.toolIdentity instanceof Map);
  assert.equal(prepared.body.tools[0].function.name, "fixture_ns__lookup");
  const bound = bindLocalArchiveToolIdentity(structuredClone(prepared.body), prepared.toolIdentity);
  assert.deepEqual(bound._toolNameMap, prepared.toolIdentity);
  assert.notEqual(bound._toolNameMap, prepared.toolIdentity);
  const native = buildNativeRequest({ stream: false }, bound, capacity);
  assert.equal(native._toolNameMap, undefined);
});

test("resident preparation receives only normalized layout and no-archive path preserves original", async (t) => {
  const root = scratch(t);
  const source = fixture();
  const prepared = prepareLocalArchiveRequest(source);
  const calls: string[] = [];
  let counters = 0;
  const result = await prepareResidentContinuation(prepared.body, { id: "synthetic-owner" }, syntheticHeaders(), metadataFetcher(calls), root, {
    originalBody: prepared.originalBody,
    counterFactory: () => (body: any) => { counters++; assert.ok(Array.isArray(body.messages)); assert.equal(body.input, undefined); return 100; },
    allocation: () => assert.fail("no physical allocation for small fixture"),
  });
  assert.equal(result.token, null);
  assert.equal(result.body, prepared.body);
  assert.deepEqual(source, fixture());
  assert.ok(counters > 0);
  assert.deepEqual(calls, [capacity.origin + "/api/ps"]);
});

test("forced archive binds normalized conversation and complete original protocol in immutable revision", async (t) => {
  const root = scratch(t);
  const source = fixture();
  source.instructions += "A".repeat(70000);
  const prepared = prepareLocalArchiveRequest(source);
  const calls: string[] = [];
  const allocations: any[] = [];
  const result = await prepareResidentContinuation(prepared.body, { id: "synthetic-owner" }, syntheticHeaders(), metadataFetcher(calls), root, {
    originalBody: prepared.originalBody,
    counterFactory: (cap: any, build: any) => (body: any) => {
      assert.ok(Array.isArray(body.messages));
      assert.equal(body.input, undefined);
      const native = build({ stream: false }, { ...body, reasoning_effort: "none" }, cap);
      assert.equal(native.options.num_ctx, cap.context);
      return 100;
    },
    allocation: (...args: any[]) => allocations.push(args),
  });
  assert.ok(result.token);
  assert.equal(allocations.length, 1);
  assert.equal(allocations[0][1], capacity.context);
  const store = new ArchiveStore(root);
  const doc = store.read(result.context.scope, result.context.revision);
  assert.deepEqual(doc.conversation.original_request.input, source.input);
  assert.equal(doc.conversation.original_request.instructions, source.instructions);
  assert.deepEqual(doc.conversation.original_request.tools, source.tools);
  assert.equal(doc.hash, crypto.createHash("sha256").update(JSON.stringify(doc.conversation)).digest("hex"));
  assert.ok(result.body.messages.some((m: any) => m.content === source.instructions));
  assert.deepEqual(source.input, fixture().input);
});

test("original protocol is included in revision integrity rather than unbound side metadata", (t) => {
  const root = scratch(t);
  const source = fixture();
  const prepared = prepareLocalArchiveRequest(source);
  const result = prepareLocalContinuation(prepared.body, { id: "synthetic-owner" }, syntheticHeaders(), root, capacity, () => 100, true, source);
  const store = new ArchiveStore(root);
  const file = path.join(root, result.context.scope, result.context.revision + ".json");
  const doc = JSON.parse(fs.readFileSync(file, "utf8"));
  doc.conversation.original_request.instructions = "tampered synthetic instruction";
  fs.chmodSync(file, 0o600);
  fs.writeFileSync(file, JSON.stringify(doc));
  fs.chmodSync(file, 0o400);
  assert.throws(() => store.read(result.context.scope, result.context.revision), /archive_integrity_failure/);
});

test("pre-aborted request stops before metadata, counter, archive or inference", async (t) => {
  const root = scratch(t);
  const controller = new AbortController(); controller.abort();
  let observations = 0;
  const prepared = prepareLocalArchiveRequest(fixture());
  await assert.rejects(() => prepareResidentContinuation(prepared.body, { id: "synthetic-owner" }, syntheticHeaders(), async () => { observations++; throw new Error("must not observe"); }, root, {
    signal: controller.signal,
    counterFactory: () => { assert.fail("must not construct counter"); },
  }), { name: "AbortError" });
  assert.equal(observations, 0);
  assert.equal(fs.existsSync(root), false);
});

test("wrong resident identity is refused without counter, allocation or inference", async (t) => {
  const root = scratch(t); const calls: string[] = [];
  const prepared = prepareLocalArchiveRequest(fixture());
  await assert.rejects(() => prepareResidentContinuation(prepared.body, { id: "synthetic-owner" }, syntheticHeaders(), metadataFetcher(calls, [{ name: capacity.model, digest: "invalid", context_length: capacity.context }]), root, {
    counterFactory: () => { assert.fail("counter forbidden after identity failure"); },
    allocation: () => assert.fail("allocation forbidden after identity failure"),
  }), (error: any) => error.code === "local_context_unavailable" && error.details.reason === "invalid_resident_metadata");
  assert.equal(fs.existsSync(root), false);
});

test("unsupported Responses item is rejected before metadata, archive or dispatch", () => {
  const source = fixture() as any;
  source.input.push({ type: "unsupported_fixture_item", secret_fixture_value: "must remain private" });
  assert.throws(() => prepareLocalArchiveRequest(source));
  assert.equal(source.input.at(-1).secret_fixture_value, "must remain private");
});

test("image in tool output is refused before canonical placeholder conversion or any dispatch", () => {
  const source = fixture() as any;
  source.input[2].output = [{ type: "input_image", image_url: "data:image/png;base64,U1lOVEhFVElD" }];
  assert.throws(() => prepareLocalArchiveRequest(source));
  assert.equal(source.input[2].output[0].type, "input_image");
});

test("malformed function call is refused rather than silently removed", () => {
  const source = fixture();
  source.input[1].name = "";
  assert.throws(() => prepareLocalArchiveRequest(source));
  assert.equal(source.input.length, 3);
});

test("unsupported hosted image-generation tool is refused instead of silently removed", () => {
  const source = fixture() as any;
  source.tools.push({ type: "image_generation" });
  assert.throws(() => prepareLocalArchiveRequest(source));
  assert.equal(source.tools.length, 2);
});


test("namespace history keeps distinct qualified names for colliding leaves", () => {
  const source = fixture() as any;
  source.tools = ["alpha", "beta"].map(name => ({ type: "namespace", name, tools: [{ type: "function", name: "read", parameters: { type: "object" } }] }));
  source.input = [source.input[0], ...["alpha", "beta"].flatMap(namespace => [
    { type: "function_call", namespace, name: "read", call_id: namespace, arguments: "{}" },
    { type: "function_call_output", call_id: namespace, output: namespace + " result" },
  ])];
  const prepared = prepareLocalArchiveRequest(source);
  const calls = prepared.body.messages.flatMap((m: any) => m.tool_calls || []);
  assert.deepEqual(calls.map((c: any) => c.function.name), ["alpha__read", "beta__read"]);
  assert.deepEqual(calls.map((c: any) => c.id), ["alpha", "beta"]);
  assert.deepEqual(prepared.body.tools.map((t: any) => t.function.name), ["alpha__read", "beta__read"]);
  assert.deepEqual(prepared.originalBody, source);
  const direct = openaiResponsesToOpenAIRequest("ollama-local", structuredClone(source), false, null) as any;
  assert.deepEqual(direct.messages, prepared.body.messages);
});

test("namespaced custom history and output classification do not collide with function leaves", () => {
  const source = fixture() as any;
  source.tools = [
    { type: "namespace", name: "commands", tools: [{ type: "custom", name: "exec", format: { type: "text" } }] },
    { type: "namespace", name: "other", tools: [{ type: "function", name: "exec", parameters: { type: "object" } }] },
  ];
  source.input = [source.input[0], { type: "custom_tool_call", namespace: "commands", name: "exec", call_id: "custom_ns", input: "raw fixture" }, { type: "custom_tool_call_output", call_id: "custom_ns", output: "done" }];
  const prepared = prepareLocalArchiveRequest(source);
  const call = prepared.body.messages.flatMap((m: any) => m.tool_calls || [])[0];
  assert.equal(call.function.name, "commands__exec");
  assert.deepEqual(JSON.parse(call.function.arguments), { input: "raw fixture" });
  const names = collectCustomToolNamesForSourceFormat("openai-responses", "openai-responses", source.tools, source.input);
  assert.ok(names.has("commands__exec"));
  assert.equal(names.has("other__exec"), false);
  const rebound = bindLocalArchiveToolIdentity(structuredClone(prepared.body), prepared.toolIdentity);
  assert.deepEqual(rebound._toolNameMap.get("commands__exec"), { namespace: "commands", name: "exec" });
});
