import test from "node:test";
import http from "node:http";
import assert from "node:assert/strict";

// A dead credential used to pass the connection test: the upstream answered the chat probe with
// HTTP 400 "Authorization header is badly formatted" and every validator treated a 400 as
// "reachable, auth ok". 400 whose body text matches the router's credential-rejection patterns
// must now be INVALID; every other 400/422/429 stays valid exactly as before.

const { validateOpenAILikeProvider, validateOpenAICompatibleProvider } =
  await import("../../src/lib/providers/validation/openaiFormat.ts");
const { validateDirectChatProvider } =
  await import("../../src/lib/providers/validation/directChatProbe.ts");
const { validateAnthropicCompatibleProvider } =
  await import("../../src/lib/providers/validation/anthropicFormat.ts");
const { validateKiroApiKeyRuntimeProbe } =
  await import("../../src/lib/providers/validation/kiro.ts");
const { validateClarifaiProvider, validateEmbeddingApiProvider, validateRerankApiProvider } =
  await import("../../src/lib/providers/validation/embeddingProviders.ts");
const { validateWatsonxProvider, validateOciProvider, validateSapProvider } =
  await import("../../src/lib/providers/validation/cloudProviders.ts");
const { validateRekaProvider, validateNlpCloudProvider, validateQwenCloudTokenPlanProvider } =
  await import("../../src/lib/providers/validation/audioMiscProviders.ts");
const { validateNvidiaProvider, validateZaiProvider, validateXiaomiMimoProvider } =
  await import("../../src/lib/providers/validation/specialtyInline.ts");
const { validateProviderApiKey } = await import("../../src/lib/providers/validation.ts");
const { testOAuthConnection } = await import("../../src/app/api/providers/[id]/test/route.ts");

const originalFetch = globalThis.fetch;
test.afterEach(() => {
  globalThis.fetch = originalFetch;
});

const BADLY_FORMATTED = "Authorization header is badly formatted";
const SENTINEL = "SENTINEL-SECRET-VALUE-9f3a";

function textResponse(status: number, body: string, contentType = "text/plain") {
  return new Response(body, { status, headers: { "content-type": contentType } });
}
function jsonResponse(status: number, body: unknown) {
  return textResponse(status, JSON.stringify(body), "application/json");
}

/** GET/HEAD -> 404 (so validators fall through to their write probe); POST -> `probe()`. */
function stubFetch(probe: () => Response) {
  const calls: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const method = (
      init?.method ||
      (input instanceof Request ? input.method : "") ||
      "GET"
    ).toUpperCase();
    calls.push({ url, method });
    return method === "GET" || method === "HEAD" ? textResponse(404, "not found") : probe();
  }) as typeof fetch;
  return calls;
}

// ── Entry points sharing the "400 => reachable" fallthrough ───────────────────────────────────
type ValidationResult = {
  valid: boolean;
  error?: string | null;
  warning?: string;
};
type Runner = (apiKey: string) => Promise<ValidationResult>;
const ENTRY_POINTS: Array<[string, Runner]> = [
  [
    "openai-like chat probe",
    (apiKey) =>
      validateOpenAILikeProvider({
        provider: "github",
        apiKey,
        baseUrl: "https://api.example.com/v1",
        modelId: "m",
        providerSpecificData: {},
      }),
  ],
  [
    "openai-compatible chat probe",
    (apiKey) =>
      validateOpenAICompatibleProvider({
        apiKey,
        providerSpecificData: { baseUrl: "https://api.example.com/v1", validationModelId: "m" },
      }),
  ],
  [
    "direct chat probe",
    (apiKey) =>
      validateDirectChatProvider({
        url: "https://api.example.com/chat",
        headers: { Authorization: `Bearer ${apiKey}` },
        body: { model: "m" },
      }),
  ],
  [
    "anthropic-compatible messages probe",
    (apiKey) =>
      validateAnthropicCompatibleProvider({
        apiKey,
        providerSpecificData: { baseUrl: "https://api.example.com/v1" },
      }),
  ],
  [
    "kiro runtime probe",
    (apiKey) => validateKiroApiKeyRuntimeProbe({ apiKey, region: "us-east-1" }),
  ],
  ["clarifai", (apiKey) => validateClarifaiProvider({ apiKey })],
  [
    "embedding api",
    (apiKey) =>
      validateEmbeddingApiProvider({
        apiKey,
        url: "https://api.example.com/embeddings",
        modelId: "m",
      }),
  ],
  [
    "rerank api",
    (apiKey) =>
      validateRerankApiProvider({ apiKey, url: "https://api.example.com/rerank", modelId: "m" }),
  ],
  ["watsonx", (apiKey) => validateWatsonxProvider({ apiKey })],
  [
    "oci",
    (apiKey) =>
      validateOciProvider({
        apiKey,
        providerSpecificData: { baseUrl: "https://inference.example.com/openai/v1" },
      }),
  ],
  [
    "sap",
    (apiKey) =>
      validateSapProvider({
        apiKey,
        providerSpecificData: {
          baseUrl: "https://sap.example.com/v2/inference/deployments/d1/chat/completions",
        },
      }),
  ],
  ["reka", (apiKey) => validateRekaProvider({ apiKey })],
  ["nlpcloud", (apiKey) => validateNlpCloudProvider({ apiKey })],
  ["qwen cloud token plan", (apiKey) => validateQwenCloudTokenPlanProvider({ apiKey })],
  ["xiaomi-mimo", (apiKey) => validateXiaomiMimoProvider({ apiKey })],
  [
    "dispatcher: command-code",
    (apiKey) => validateProviderApiKey({ provider: "command-code", apiKey }),
  ],
];

for (const [name, run] of ENTRY_POINTS) {
  test(`credential-400: ${name} reports a rejected authorization header as INVALID`, async () => {
    stubFetch(() => textResponse(400, BADLY_FORMATTED));
    const result = await run("test-key-abcdef");
    assert.equal(result.valid, false, `${name} should be invalid`);
    assert.match(String(result.error), /credential rejected by upstream/i);
    assert.match(String(result.error), /badly formatted/i);
  });

  test(`credential-400: ${name} keeps an unrelated 400 valid`, async () => {
    stubFetch(() => jsonResponse(400, { error: { message: "model not supported" } }));
    const result = await run("test-key-abcdef");
    assert.equal(result.valid, true, `${name} should stay valid on an unrelated 400`);
  });
}

// ── Detailed behaviour, exercised on the openai-like chat probe ───────────────────────────────
const probe = (apiKey = "test-key-abcdef") =>
  validateOpenAILikeProvider({
    provider: "github",
    apiKey,
    baseUrl: "https://api.example.com/v1",
    modelId: "m",
    providerSpecificData: {},
  });

test("credential-400: JSON { error: { message } } body is INVALID", async () => {
  stubFetch(() => jsonResponse(400, { error: { message: BADLY_FORMATTED, code: "bad_request" } }));
  const r = await probe();
  assert.equal(r.valid, false);
  assert.match(r.error, /^credential rejected by upstream: /);
  assert.match(r.error, /badly formatted/i);
});

test("credential-400: JSON top-level message body is INVALID", async () => {
  stubFetch(() => jsonResponse(400, { message: BADLY_FORMATTED }));
  const r = await probe();
  assert.equal(r.valid, false);
  assert.match(r.error, /badly formatted/i);
});

test("credential-400: malformed / invalid authorization header wordings are INVALID", async () => {
  for (const text of [
    "Authorization header is malformed",
    "Authorization header is invalid",
    "invalid authorization header",
    "Malformed Authorization Header",
  ]) {
    stubFetch(() => textResponse(400, text));
    const r = await probe();
    assert.equal(r.valid, false, `expected invalid for: ${text}`);
  }
});

test("credential-400: unrelated 400 bodies stay valid (model not supported, invalid request, OAuth code)", async () => {
  for (const body of [
    "model not supported",
    "invalid request",
    JSON.stringify({ error: "invalid_grant", error_description: "authorization code is invalid" }),
    JSON.stringify({ error: { message: "The model `m` does not exist" } }),
  ]) {
    stubFetch(() => textResponse(400, body));
    const r = await probe();
    assert.equal(r.valid, true, `expected valid for: ${body}`);
    assert.equal(r.error, null);
  }
});

test("credential-400: empty and non-text 400 bodies stay valid", async () => {
  stubFetch(() => new Response(null, { status: 400 }));
  assert.equal((await probe()).valid, true);

  stubFetch(
    () =>
      new Response(new Uint8Array([0xff, 0xfe, 0x00, 0x01, 0xc3, 0x28]), {
        status: 400,
        headers: { "content-type": "application/octet-stream" },
      })
  );
  assert.equal((await probe()).valid, true);
});

test("credential-400: 422 and 429 with rejection wording are unchanged (only 400 is reclassified)", async () => {
  stubFetch(() => textResponse(422, BADLY_FORMATTED));
  assert.equal((await probe()).valid, true);

  stubFetch(() => textResponse(429, BADLY_FORMATTED));
  const r429 = await probe();
  assert.equal(r429.valid, true);
  assert.match(String(r429.warning), /rate limited/i);
});

test("credential-400: 401/403/5xx handling is unchanged", async () => {
  stubFetch(() => textResponse(401, BADLY_FORMATTED));
  assert.deepEqual(await probe(), { valid: false, error: "Invalid API key" });

  stubFetch(() => textResponse(403, "forbidden"));
  assert.deepEqual(await probe(), { valid: false, error: "Invalid API key" });

  stubFetch(() => textResponse(503, "down"));
  assert.deepEqual(await probe(), { valid: false, error: "Provider unavailable (503)" });
});

test("credential-400: existing result shape is unchanged for a healthy probe", async () => {
  stubFetch(() => jsonResponse(200, { id: "x" }));
  assert.deepEqual(await probe(), { valid: true, error: null });
});

test("credential-400: a /models 400 with rejection wording short-circuits as INVALID", async () => {
  globalThis.fetch = (async () => textResponse(400, BADLY_FORMATTED)) as typeof fetch;
  const r = await probe();
  assert.equal(r.valid, false);
  assert.match(r.error, /credential rejected by upstream/i);
});

test("credential-400: a 1 MB body is bounded, not read in full", async () => {
  let pulledBytes = 0;
  const chunk = new TextEncoder().encode(`${BADLY_FORMATTED} ${"x".repeat(16 * 1024)}`);
  const totalChunks = 64; // ~1 MB
  stubFetch(() => {
    let sent = 0;
    const stream = new ReadableStream<Uint8Array>(
      {
        pull(controller) {
          if (sent >= totalChunks) return controller.close();
          sent += 1;
          pulledBytes += chunk.byteLength;
          controller.enqueue(chunk);
        },
      },
      { highWaterMark: 0 }
    );
    return new Response(stream, { status: 400 });
  });
  const r = await probe();
  assert.equal(r.valid, false);
  assert.ok(r.error.length <= "credential rejected by upstream: ".length + 200);
  assert.ok(pulledBytes < 256 * 1024, `pulled ${pulledBytes} bytes of a ~1 MB body`);
});

test("credential-400: the excerpt is bounded to 200 characters", async () => {
  stubFetch(() => textResponse(400, `${BADLY_FORMATTED} ${"detail ".repeat(400)}`));
  const r = await probe();
  assert.equal(r.valid, false);
  const excerpt = r.error.replace(/^credential rejected by upstream: /, "");
  assert.ok(excerpt.length <= 200, `excerpt was ${excerpt.length} chars`);
});

test("credential-400: a sentinel secret in the upstream body is never echoed", async () => {
  const bodies = [
    `${BADLY_FORMATTED}: Bearer ${SENTINEL}`,
    `${BADLY_FORMATTED} (got ${SENTINEL})`,
    JSON.stringify({ error: { message: `${BADLY_FORMATTED}; api_key=${SENTINEL}` } }),
    JSON.stringify({ message: `${BADLY_FORMATTED}`, authorization: `Bearer ${SENTINEL}` }),
    `${BADLY_FORMATTED} token ghp_${"a1B2c3D4e5".repeat(4)}`,
  ];
  for (const body of bodies) {
    stubFetch(() => textResponse(400, body));
    const r = await probe(SENTINEL);
    assert.equal(r.valid, false);
    const serialized = JSON.stringify(r);
    assert.ok(!serialized.includes(SENTINEL), `sentinel leaked for body: ${body}`);
    assert.ok(!serialized.includes("a1B2c3D4e5"), `key-shaped token leaked for body: ${body}`);
  }
});

test("credential-400: the request Authorization header is never part of the result", async () => {
  stubFetch(() => textResponse(400, BADLY_FORMATTED));
  const r = await probe(SENTINEL);
  assert.ok(!JSON.stringify(r).includes(SENTINEL));
  assert.ok(!/authorization:/i.test(JSON.stringify(r)));
});

// ── OAuth connection test (acceptStatuses: [400] providers) ───────────────────────────────────
function oauthCodexConnection() {
  return {
    provider: "codex",
    accessToken: "oauth-access-token-value",
    refreshToken: null,
    tokenExpiresAt: new Date(Date.now() + 3600_000).toISOString(),
    providerSpecificData: {},
  };
}

test("credential-400: OAuth probe 400 with rejection wording is INVALID", async () => {
  stubFetch(() => textResponse(400, BADLY_FORMATTED));
  globalThis.fetch = (async () => textResponse(400, BADLY_FORMATTED)) as typeof fetch;
  const r = (await testOAuthConnection(oauthCodexConnection())) as ValidationResult;
  assert.equal(r.valid, false);
  assert.match(String(r.error), /credential rejected by upstream/i);
});

test("credential-400: OAuth probe 400 with the intended invalid-body error stays valid", async () => {
  globalThis.fetch = (async () =>
    jsonResponse(400, { detail: "Invalid input: expected array" })) as typeof fetch;
  const r = (await testOAuthConnection(oauthCodexConnection())) as ValidationResult;
  assert.equal(r.valid, true);
});

// ── nvidia / zai use directHttpsRequest (bypasses globalThis.fetch): hit a loopback server ────
async function withLoopback(
  status: number,
  body: string,
  fn: (baseUrl: string) => Promise<void>
): Promise<void> {
  const server = http.createServer((_req, res) => {
    res.statusCode = status;
    res.setHeader("content-type", "text/plain");
    res.end(body);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

const DIRECT_HTTPS: Array<
  [string, (baseUrl: string, apiKey: string) => Promise<ValidationResult>]
> = [
  [
    "nvidia (directHttpsRequest)",
    (baseUrl, apiKey) =>
      validateNvidiaProvider({
        apiKey,
        providerSpecificData: { baseUrl: `${baseUrl}/v1/chat/completions` },
      }),
  ],
  [
    "zai (directHttpsRequest)",
    (baseUrl, apiKey) => validateZaiProvider({ apiKey, providerSpecificData: { baseUrl } }),
  ],
];

for (const [name, run] of DIRECT_HTTPS) {
  test(`credential-400: ${name} rejected authorization header is INVALID, sentinel not echoed`, async () => {
    await withLoopback(400, `${BADLY_FORMATTED} Bearer ${SENTINEL}`, async (baseUrl) => {
      const r = await run(baseUrl, SENTINEL);
      assert.equal(r.valid, false);
      assert.match(String(r.error), /credential rejected by upstream/i);
      assert.ok(!JSON.stringify(r).includes(SENTINEL));
    });
  });
  test(`credential-400: ${name} unrelated 400 stays valid`, async () => {
    await withLoopback(400, "model not supported", async (baseUrl) => {
      const r = await run(baseUrl, "test-key-abcdef");
      assert.equal(r.valid, true);
    });
  });
}
