---
title: Configured account admission
---

# Configured-account admission

Stored combo configuration can set `costAdmissionMode: "configured-accounts"` to permit normal usage of its active configured accounts. This is **not** a guarantee of zero billing: subscription allowances, credits or normal account charges may apply. Other combos retain the existing strict zero-cost behavior. Request bodies and headers cannot enable this mode.

`runWithHostedTrialUsage` in `open-sse/services/autoCombo/hostedTrialUsage.ts` captures the stored mode and provider scope. Nested policies intersect provider scopes and cannot widen a strict parent. `hasCurrentCostAdmission` in `open-sse/services/autoCombo/zeroCostAdmission.ts` applies the effective policy; `hasCurrentZeroCostAdmission` retains its strict meaning. Concrete active account binding is read by `getActiveCostAdmissionAccount` in `src/lib/db/providers.ts` without reading credentials.

The effective check is used before scoring, availability, credential retry and final dispatch. It does not replace API-key/account scope, quota, budget, capability, health or automatic model ranking. `chatCore.ts` captures immutable request policy; HTTP and Codex WebSocket dispatch recheck admission. Routing decision factors record `costAdmissionMode`, and configured-account failures use appropriate eligibility messages.
