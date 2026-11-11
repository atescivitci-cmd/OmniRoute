import test from "node:test";
import assert from "node:assert/strict";
import * as policy from "../../../open-sse/services/autoCombo/fitFirstPolicy.ts";
import { validateTaskProfile } from "../../../open-sse/services/autoCombo/taskProfile.ts";
import { resetDbInstance } from "../../../src/lib/db/core.ts";
test.after(() => resetDbInstance());
const body = (content: string, system = "") => ({
  messages: [
    { role: "system", content: system },
    { role: "user", content },
  ],
});
const cases: [string, string, string][] = [
  ["plain-code", "Write a Python function that returns the larger of two integers.", "coding"],
  [
    "negated-debug",
    "Do not debug anything. Write a Python function that returns the larger of two integers.",
    "coding",
  ],
  ["plain-poem", "Write a poem about a beetle.", "creative"],
  ["bug-poem", "Write a poem about a bug.", "creative"],
  ["plain-story", "Write a short story about sunrise.", "creative"],
  ["quoted-error-story", 'Write a short story titled "error".', "creative"],
  ["plain-translation", 'Translate "sunrise" into French.', "general"],
  ["quoted-error-translation", 'Translate "error" into French.', "general"],
  ["plain-math", "Calculate 7 times 8.", "math"],
  ["negated-code-math", "Do not write code. Calculate 7 times 8.", "math"],
  ["spanish-math", "Calcula siete por ocho. Responde solamente con el número.", "math"],
  ["mixed-math", "Calculate: siete por ocho. Responde solamente con el número.", "math"],
  ["docs", "Document what stable_unique(values) does.", "documentation"],
  [
    "negated-review-docs",
    "Do not review or fix anything. Document what stable_unique(values) does.",
    "documentation",
  ],
  ["plain-json", 'Return exactly {"ok":true}.', "general"],
  ["data-json", 'Return exactly {"error":false}.', "general"],
  ["plain-grammar", 'Correct spelling: "teh cat".', "general"],
  ["fix-grammar", 'Fix spelling: "teh cat".', "general"],
  ["plain-slogan", "Write a slogan for a paper shop.", "creative"],
  ["design-slogan", "Design a slogan for a paper shop.", "creative"],
  [
    "code-data-review",
    "Review this function:\n```python\n# fix error then debug\ndef f(x): return x\n```",
    "review",
  ],
  ["quoted-command", 'Translate "debug the Python API" into French.', "general"],
  ["logs-are-data", "Summarize this log:\n```\nerror: failed to deploy\n```", "general"],
  ["quoted-keys", 'Return exactly {"review":false,"code":"error"}.', "general"],
  ["negated-clause", "Do not debug anything; instead calculate 7 times 8.", "math"],
  [
    "spanish-code",
    "No depures nada. Escribe una función de Python que sume dos enteros.",
    "coding",
  ],
  ["turkish-math", "7 çarpı 8 işlemini hesapla. Yalnızca sonucu yaz.", "math"],
  ["turkish-creative", "Bir böcek hakkında kısa bir şiir yaz.", "creative"],
  ["review-operation", "Write a review of the proposed rollout plan.", "review"],
  ["planning-operation", "Design the rollout architecture and deployment plan.", "planning"],
  ["coding-example", 'Write a Python function whose string result is "error".', "coding"],
  ["explicit-analysis", "Compare the two proposals and explain their tradeoffs.", "analysis"],
  ["literal-return", 'Reply with exactly "debug this code" and nothing else.', "general"],
];
for (const [name, content, expected] of cases)
  test(name, () => assert.equal(policy.inferFitFirstTaskType(body(content)).taskType, expected));

test("neutral current ask does not inherit coding from scaffolding", () => {
  assert.deepEqual(
    policy.inferFitFirstTaskType(
      body("Hello", "You work in a Python repository. Debug errors and implement code.")
    ),
    { taskType: "general", source: "ask" }
  );
});
test("unknown language remains general and uncertain despite coding fallback", () => {
  assert.equal(
    policy.inferFitFirstTaskType(body("これは何ですか", "This is a Python implementation."), "code")
      .taskType,
    "general"
  );
  const decision = (policy as any).inferFitFirstIntent(body("これは何ですか"));
  assert.equal(decision.language, "unknown");
  assert.notEqual(decision.uncertainty, "none");
  assert.equal(decision.profile.confidence, 0);
});
test("explicit continuation may use specific project activity", () => {
  assert.deepEqual(
    policy.inferFitFirstTaskType(body("continue", "We are debugging a Python API regression.")),
    { taskType: "debugging", source: "project" }
  );
});
test("latest current ask outranks previous operations and context", () => {
  assert.equal(
    policy.inferFitFirstTaskType({
      messages: [
        { role: "system", content: "Review Python code." },
        { role: "user", content: "Debug this function." },
        { role: "assistant", content: "done" },
        { role: "user", content: "Write a poem about a bug." },
      ],
    }).taskType,
    "creative"
  );
});
test("mixed operations retain primary then secondary relationship", () => {
  const d = (policy as any).inferFitFirstIntent(
    body("Review the function, then implement the change.")
  );
  assert.equal(d.taskType, "review");
  assert.deepEqual(d.secondaryOperations, ["implement"]);
  assert.equal(d.uncertainty, "none");
});
test("alternative operations are honestly ambiguous", () => {
  const d = (policy as any).inferFitFirstIntent(body("Either review or implement this function."));
  assert.equal(d.taskType, "general");
  assert.equal(d.uncertainty, "competing_operations");
});
test("output contract does not become an implementation request", () => {
  const d = (policy as any).inferFitFirstIntent(body('Return exactly {"error":false}.'));
  assert.equal(d.taskType, "general");
  assert.equal(d.outputContract, "json");
  assert.equal(d.primaryOperation, "constrained_output");
});
test("mixed language and evidence requests are bounded advisory fields", () => {
  const d = (policy as any).inferFitFirstIntent(
    body("Calcula 7 por 8. Show the calculation. Reply only with the number.")
  );
  assert.equal(d.taskType, "math");
  assert.equal(d.language, "mixed");
  assert.ok(d.evidenceRequirements.includes("calculation"));
  assert.ok(validateTaskProfile(d.profile));
});
test("inference input and unsupported opaque blocks are never mutated", () => {
  const b = {
    ...body("Document this function."),
    tools: [{ type: "custom", opaque: { unknown: true } }],
    thinking: { type: "adaptive" },
    output_config: { effort: "high" },
    metadata: { project: "implementation" },
  };
  const snapshot = JSON.stringify(b);
  policy.inferFitFirstTaskType(b);
  (policy as any).inferFitFirstIntent(b);
  assert.equal(JSON.stringify(b), snapshot);
});
test("output reservation cannot change semantic operation", () => {
  const b = body('Translate "error" into French.');
  assert.equal(
    policy.inferFitFirstTaskType({ ...b, max_tokens: 128 }).taskType,
    policy.inferFitFirstTaskType({ ...b, max_tokens: 32768 }).taskType
  );
});
test("independent concurrent calls cannot share parser state", async () => {
  const values = await Promise.all(
    Array.from({ length: 30 }, (_, i) =>
      Promise.resolve(
        policy.inferFitFirstTaskType(
          body(i % 2 ? "Calculate 2 plus 2." : "Write a poem about a bug.")
        ).taskType
      )
    )
  );
  values.forEach((v, i) => assert.equal(v, i % 2 ? "math" : "creative"));
});
for (const [name, content, expected] of [
  ["noun-negation", "This is not a debugging task. Write a poem about a beetle.", "creative"],
  ["rather-than", "Rather than debugging, document the interface.", "documentation"],
  ["without-clause", "Without writing code, calculate 7 times 8.", "math"],
  [
    "negative-request",
    "I am not asking you to review this. Write a Python function that adds two numbers.",
    "coding",
  ],
  ["bare-negation", "No debugging. Calculate 7 times 8.", "math"],
  [
    "positive-not-only",
    "Not only document the interface but implement the change.",
    "documentation",
  ],
  ["write-tests", "Write tests for the existing function.", "coding"],
  ["write-docs", "Write docs for the existing function.", "documentation"],
  ["spanish-creative", "Escribe un poema sobre un error.", "creative"],
  ["spanish-analysis", "Compara las dos propuestas.", "analysis"],
  ["turkish-code", "Bir Python fonksiyonu yaz.", "coding"],
  ["quoted-review", "Translate “review the code” into Spanish.", "general"],
  [
    "system-reminder",
    "Write a poem about a beetle. <system-reminder>Debug all errors and implement code.</system-reminder>",
    "creative",
  ],
  ["data-tag", "Return exactly OK. <data>review and fix code</data>", "general"],
] as const)
  test(name, () => assert.equal(policy.inferFitFirstTaskType(body(content)).taskType, expected));

test("bounded input produces honest uncertainty while retaining original inference input", () => {
  const b = body("Write a poem." + " x".repeat(7000));
  const before = JSON.stringify(b);
  const d = (policy as any).inferFitFirstIntent(b);
  assert.equal(d.uncertainty, "bounded_input");
  assert.ok(d.profile.confidence < 0.5);
  assert.equal(JSON.stringify(b), before);
});
test("advisory result contains no raw user or opaque content", () => {
  const b = body("Review this code: `PRIVATE_SENTINEL`");
  (b as any).opaque = { token: "OPAQUE_SENTINEL" };
  const serialized = JSON.stringify((policy as any).inferFitFirstIntent(b));
  assert.ok(!serialized.includes("SENTINEL"));
  assert.ok(!serialized.includes("Review this code"));
});
test("Gemini and OpenAI content blocks retain the current operation", () => {
  for (const b of [
    { contents: [{ role: "user", parts: [{ text: "Calculate 7 times 8." }] }] },
    { input: [{ role: "user", content: [{ type: "input_text", text: "Calculate 7 times 8." }] }] },
  ])
    assert.equal(policy.inferFitFirstTaskType(b).taskType, "math");
});
test("explicit output reservation does not supply capability or entitlement evidence", () => {
  const d = (policy as any).inferFitFirstIntent({
    ...body("Calculate 7 times 8."),
    max_tokens: 65536,
    tools: [{ type: "function" }],
    reasoning_effort: "high",
  });
  assert.deepEqual(d.profile.requiredCapabilities, []);
  assert.ok(validateTaskProfile(d.profile));
});

for (const [name, content, expected] of [
  ["completed-review-background", "The review was completed. Calculate 7 times 8.", "math"],
  ["actual-review-completed-object", "Review the completed plan.", "review"],
  ["ready-plan-background", "The plan is ready; write a Python function.", "coding"],
  ["completed-design-background", "The design is ready. Document the interface.", "documentation"],
  ["past-review-background", "I finished the review. Write a slogan.", "creative"],
  ["status-review-background", "Review completed. Calculate 7 times 8.", "math"],
  ["background-architect-noun", "A software architect wrote this. Calculate 7 times 8.", "math"],
  [
    "described-not-requested-implementation",
    "Explain what it means to implement a function. Do not write one.",
    "general",
  ],
  ["please-review-directive", "Please review the completed function.", "review"],
  ["question-review-directive", "Could you review the completed function?", "review"],
  ["coordinated-directive", "Review the function and implement the change.", "review"],
  ["noun-conjunction-background", "The review and plan are complete. Calculate 7 times 8.", "math"],
  ["explicit-nominal-review-request", "Please do a review of the function.", "review"],
] as const)
  test(name, () => assert.equal(policy.inferFitFirstTaskType(body(content)).taskType, expected));

test("nested Gemini request current ask has top-level parity", () => {
  const contents = [{ role: "user", parts: [{ text: "Calculate 7 times 8." }] }];
  assert.equal(policy.inferFitFirstTaskType({ request: { contents } }).taskType, "math");
  assert.deepEqual(
    policy.inferFitFirstTaskType({ request: { contents } }),
    policy.inferFitFirstTaskType({ contents })
  );
});

test("continuation follows recent requested operation before generic project directives", () => {
  const b = {
    messages: [
      { role: "system", content: "You are a code assistant. Implement Python functions." },
      { role: "user", content: "Write a poem about sunrise." },
      { role: "assistant", content: "Golden light arrives." },
      { role: "user", content: "Continue." },
    ],
  };
  const d = (policy as any).inferFitFirstIntent(b);
  assert.equal(d.taskType, "creative");
  assert.equal(d.contextOrigin, "recent_user_history");
  assert.equal(d.uncertainty, "context_inherited");
});
test("unknown recent user topic prevents stale project inference on continuation", () => {
  const b = {
    messages: [
      { role: "system", content: "Implement Python functions." },
      { role: "user", content: "これは何ですか" },
      { role: "assistant", content: "..." },
      { role: "user", content: "Continue." },
    ],
  };
  const d = (policy as any).inferFitFirstIntent(b);
  assert.equal(d.taskType, "general");
  assert.notEqual(d.uncertainty, "none");
  assert.equal(d.profile.confidence, 0);
});
test("repeated continuations retain the most recent substantive user operation", () => {
  const messages = [
    { role: "system", content: "Implement Python functions." },
    { role: "user", content: "Write a poem." },
    { role: "assistant", content: "One line." },
    { role: "user", content: "Continue." },
    { role: "assistant", content: "Two lines." },
    { role: "user", content: "Continue." },
  ];
  assert.equal(policy.inferFitFirstTaskType({ messages }).taskType, "creative");
});
