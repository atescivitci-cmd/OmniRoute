import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import vm from "node:vm";
import ts from "typescript";

// Execute the actual product CallExpression with a signature-compatible sink.
// This catches argument-position drift without invoking the handler, filesystem
// continuation store, daemon metadata, credentials or inference.
const path = new URL("../../src/sse/handlers/chat.ts", import.meta.url);
const source = ts.createSourceFile(
  path.pathname,
  fs.readFileSync(path, "utf8"),
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS
);
const calls: ts.CallExpression[] = [];
function visit(node: ts.Node) {
  if (
    ts.isCallExpression(node) &&
    node.expression.getText(source) === "archive.prepareResidentContinuation"
  )
    calls.push(node);
  ts.forEachChild(node, visit);
}
visit(source);
for (const parent of ["request", "target"] as const)
  test(`actual resident preparation call binds sixth options to ${parent} abort`, () => {
    assert.equal(calls.length, 1);
    let args: unknown[] = [];
    const outer = new AbortController(),
      target = new AbortController();
    const context: any = {
      AbortSignal,
      body: { messages: [] },
      apiKeyInfo: { id: "fixture" },
      clientRawRequest: { headers: new Headers() },
      request: { signal: outer.signal },
      runtimeOptions: { modelAbortSignal: target.signal },
      archive: {
        prepareResidentContinuation(...values: unknown[]) {
          args = values;
          return { body: values[0] };
        },
      },
    };
    const js = ts.transpileModule(`globalThis.result = ${calls[0].getText(source)};`, {
      compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText;
    vm.runInNewContext(js, context, { timeout: 1000 });
    assert.equal(args.length, 6);
    assert.equal(args[3], undefined);
    assert.equal(args[4], undefined);
    const signal = (args[5] as { signal: AbortSignal }).signal;
    assert.equal(signal.aborted, false);
    (parent === "request" ? outer : target).abort();
    assert.equal(signal.aborted, true);
  });
