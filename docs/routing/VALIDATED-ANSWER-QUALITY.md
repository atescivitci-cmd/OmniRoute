---
title: "Validated answer quality"
---

# Validated answer quality

A completed HTTP request establishes transport reliability, not a correct answer.
`open-sse/services/autoCombo/validatedAnswerQuality.ts` provides a bounded score
penalty for responses rejected by a client's deterministic validator. It does not
remove candidates, override account admission, or name a preferred provider.

An authenticated non-streaming request may identify its output contract with
`metadata.omniroute_quality_contract`. After completion, `open-sse/handlers/chatCore.ts`
issues an opaque `x-omniroute-quality-receipt`. The server records the authenticated
API-key owner, combo, contract, actual provider, model and account. It stores no
prompt, answer, credentials or traveler details in that receipt.

`POST /v1/routing/feedback`, implemented in
`src/app/api/v1/routing/feedback/route.ts`, accepts the receipt, a boolean
`accepted`, and a declared validation reason. The current API key must own the
receipt. Foreign, expired or unknown receipts cannot write evidence; repeating a
verdict cannot create another sample or reverse the first verdict.

`src/lib/db/answerQuality.ts` keeps this metadata in existing `key_value`
namespaces. Ranking evidence is scoped to the same API-key owner, combo, contract,
provider and model. Actual account provenance remains in the receipt; changing accounts cannot erase a semantic failure for the same model and contract. Positive samples require actual client acceptance;
HTTP success alone does not supply them. Recent failures lower rank, penalties
decay and later accepted responses reduce them. Receipt and event retention are
bounded in the persistence module.

`open-sse/services/autoCombo/deadlineAwareRouting.ts` does not let a fast response
reclaim speed promotion while its current contract has a validation penalty.
Existing eligibility, quota and local-fallback boundaries still apply. A penalized
candidate remains in the eligible pool.

For Busola, inference continues through Headroom. Validator verdicts are separate,
non-inference control-plane calls to OmniRoute. Rejected prices, citations or
itineraries remain rejected; feedback must never relax application validation to
make a model appear successful. Partial useful evidence can be retained without
accepting the rest of a mixed answer.
