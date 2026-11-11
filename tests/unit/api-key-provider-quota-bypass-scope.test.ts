import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  API_KEY_BYPASS_PROVIDER_QUOTA_SCOPE,
  hasProviderQuotaBypassScope,
} from "../../src/shared/constants/apiKeyPolicyScopes.ts";

import { buildComboRelayOptions } from "../../src/sse/handlers/comboRelayOptions.ts";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

test("provider quota bypass scope helper is explicit and strict", () => {
  assert.equal(API_KEY_BYPASS_PROVIDER_QUOTA_SCOPE, "policy:bypass-provider-quota");
  assert.equal(hasProviderQuotaBypassScope([API_KEY_BYPASS_PROVIDER_QUOTA_SCOPE]), true);
  assert.equal(hasProviderQuotaBypassScope(["policy:other"]), false);
  assert.equal(hasProviderQuotaBypassScope(null), false);
});

test("chat handler maps API key provider quota bypass scope to auth bypass option", () => {
  const source = fs.readFileSync(path.join(repoRoot, "src/sse/handlers/chat.ts"), "utf8");

  assert.match(source, /hasProviderQuotaBypassScope\(apiKeyInfo\?\.scopes\)/);
  assert.match(source, /bypassProviderQuotaPolicy[\s\S]*bypassQuotaPolicy: true/);
  assert.match(source, /relayOptions = buildComboRelayOptions\([\s\S]*bypassProviderQuotaPolicy,/);
  for (const scopes of [[API_KEY_BYPASS_PROVIDER_QUOTA_SCOPE], ["policy:other"], null]) {
    const enabled = hasProviderQuotaBypassScope(scopes);
    const relay = buildComboRelayOptions({
      combo: { strategy: "priority" },
      relayConfig: null,
      sessionId: null,
      sessionAffinityKey: null,
      bypassProviderQuotaPolicy: enabled,
      perRequestAutoControls: {},
    });
    assert.equal(relay?.bypassProviderQuotaPolicy === true, enabled);
  }
});

test("auto combo carries the trusted quota bypass separately from real status guards", () => {
  const source = fs.readFileSync(
    path.join(repoRoot, "open-sse/services/combo/resolveAutoStrategy.ts"),
    "utf8"
  );

  assert.match(source, /relayOptions\?\.bypassProviderQuotaPolicy === true/);
  assert.match(source, /resilienceSettings,\s*relayOptions\?\.bypassProviderQuotaPolicy === true/);
  assert.doesNotMatch(source, /quotaPreflight:[\s\S]*enabled: false/);
});
