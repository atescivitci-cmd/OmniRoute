import assert from "node:assert/strict";
import test from "node:test";

import {
  isComboRequestScopedFailure,
  shouldRecordProviderBreakerFailure,
} from "../../open-sse/services/combo/comboPredicates.ts";
import {
  applyComboTargetExhaustion,
  type ComboExhaustionSets,
} from "../../open-sse/services/combo/targetExhaustion.ts";

const log = { info() {}, warn() {}, error() {}, debug() {} };

function sets(): ComboExhaustionSets {
  return {
    exhaustedProviders: new Set<string>(),
    exhaustedConnections: new Set<string>(),
    transientRateLimitedProviders: new Set<string>(),
  };
}

function target() {
  return {
    kind: "model",
    executionKey: "queue-isolation",
    modelStr: "nvidia/model-a",
    provider: "nvidia",
    providerId: null,
    connectionId: "nvidia-conn-1",
  } as Parameters<typeof applyComboTargetExhaustion>[0];
}

const localQueueFailures = [
  { code: "RATE_LIMIT_QUEUE_TIMEOUT", status: 503 },
  { code: "RATE_LIMIT_QUEUE_WEDGED", status: 502 },
  { code: "RATE_LIMIT_QUEUE_FULL", status: 429 },
] as const;

for (const { code, status } of localQueueFailures) {
  test(`${code} is request-scoped and cannot poison connection/provider resilience state`, () => {
    const errorText = "OmniRoute local scheduler event";
    const structuredError = { code, type: "server_error" };
    const requestScopedFailure = isComboRequestScopedFailure(status, errorText, structuredError);

    assert.equal(requestScopedFailure, true, "local queue events are not upstream failures");

    const state = sets();
    const providerExhausted = applyComboTargetExhaustion(target(), {
      result: { status },
      fallbackResult: {},
      errorText,
      rawModel: "model-a",
      isTokenLimitBreach: false,
      allAccountsRateLimited: false,
      sets: state,
      log,
      tag: "COMBO",
      exhaustedLogLevel: "info",
      structuredError,
    });

    assert.equal(providerExhausted, false);
    assert.equal(state.exhaustedProviders.size, 0);
    assert.equal(state.exhaustedConnections.size, 0);
    assert.equal(state.transientRateLimitedProviders.size, 0);
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status,
        sameProviderNext: false,
        requestScopedFailure,
      }),
      false,
      "a local queue event must not open the provider breaker"
    );
  });

  test(`${code} remains classifiable when wrapped in an SSE error response`, () => {
    const errorText = `data: ${JSON.stringify({
      error: {
        message: "OmniRoute local scheduler event",
        type: "server_error",
        code,
      },
    })}\n\ndata: [DONE]\n\n`;
    const requestScopedFailure = isComboRequestScopedFailure(status, errorText);
    const state = sets();

    assert.equal(requestScopedFailure, true, "streaming must not erase the local queue code");
    applyComboTargetExhaustion(target(), {
      result: { status },
      fallbackResult: {},
      errorText,
      rawModel: "model-a",
      isTokenLimitBreach: false,
      allAccountsRateLimited: false,
      sets: state,
      log,
      tag: "COMBO-RR",
      exhaustedLogLevel: "debug",
    });

    assert.equal(state.exhaustedProviders.size, 0);
    assert.equal(state.exhaustedConnections.size, 0);
    assert.equal(state.transientRateLimitedProviders.size, 0);
    assert.equal(
      shouldRecordProviderBreakerFailure({
        isStreamReadinessFailure: false,
        status,
        sameProviderNext: false,
        requestScopedFailure,
      }),
      false
    );
  });
}

test("a genuine upstream 503 remains connection-scoped and breaker-eligible", () => {
  const errorText = "Service temporarily unavailable";
  const structuredError = { code: "service_unavailable", type: "server_error" };
  const requestScopedFailure = isComboRequestScopedFailure(503, errorText, structuredError);
  const state = sets();

  assert.equal(requestScopedFailure, false);
  applyComboTargetExhaustion(target(), {
    result: { status: 503 },
    fallbackResult: {},
    errorText,
    rawModel: "model-a",
    isTokenLimitBreach: false,
    allAccountsRateLimited: false,
    sets: state,
    log,
    tag: "COMBO",
    exhaustedLogLevel: "info",
    structuredError,
  });

  assert.equal(state.exhaustedConnections.has("nvidia:nvidia-conn-1"), true);
  assert.equal(
    shouldRecordProviderBreakerFailure({
      isStreamReadinessFailure: false,
      status: 503,
      sameProviderNext: false,
      requestScopedFailure,
    }),
    true
  );
});

test("human wording alone cannot reclassify a generic 503 as a local queue event", () => {
  assert.equal(
    isComboRequestScopedFailure(
      503,
      "A local rate-limit queue might be unavailable, but no machine code was provided"
    ),
    false
  );
});
