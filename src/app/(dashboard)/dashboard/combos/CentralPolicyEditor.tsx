"use client";
import { useEffect, useState } from "react";
import { policyEditorIssue, prepareCentralPolicy, stablePolicyJson, policySnapshotMatches, type PolicyRecord } from "@/lib/combos/centralPolicyEditor";

export default function CentralPolicyEditor({ comboId }: { comboId: string }) {
  const [before, setBefore] = useState<PolicyRecord | null>(null);
  const [after, setAfter] = useState<PolicyRecord | null>(null);
  const [allowed, setAllowed] = useState("");
  const [zeroCost, setZeroCost] = useState("");
  const [trial, setTrial] = useState(false);
  const [verified, setVerified] = useState(false);
  const [attempted, setAttempted] = useState(false);
  const [backup, setBackup] = useState(false);
  const [ack, setAck] = useState(false);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState("");
  const endpoint = `/api/combos/${encodeURIComponent(comboId)}`;
  async function read() {
    const response = await fetch(endpoint, { credentials: "same-origin", cache: "no-store", redirect: "error", signal: AbortSignal.timeout(15000) });
    if (!response.ok) throw new Error(`Management read failed: HTTP ${response.status}.`);
    return await response.json() as PolicyRecord;
  }
  async function load() {
    setBusy(true);
    try {
      const value = await read(); setBefore(value); setAfter(null); setVerified(false); setAttempted(false); setBackup(false); setAck(false);
      setAllowed((value.allowedProviders || []).join(", "));
      setZeroCost((value.config?.zeroAdditionalCostProviders || []).join(", "));
      setTrial(value.config?.hostedTrialUsage === "prototype-development"); setMessage("");
    } catch (e) { setMessage(e instanceof Error ? e.message : "Management read failed."); }
    finally { setBusy(false); }
  }
  useEffect(() => { void load(); }, [comboId]); // explicit refresh discards a stale draft
  const issue = before ? policyEditorIssue(before) : "Load the current combo first.";
  let proposed: PolicyRecord | null = null;
  let draftIssue = "";
  if (before && !issue) {
    try { proposed = prepareCentralPolicy(before, allowed, zeroCost, trial); }
    catch (e) { draftIssue = e instanceof Error ? e.message : "Invalid policy."; }
  }
  function downloadBackup() {
    if (!before) return;
    const url = URL.createObjectURL(new Blob([JSON.stringify(before, null, 2)], { type: "application/json" }));
    const a = document.createElement("a"); a.href = url; a.download = `combo-${comboId}-before.json`; a.click();
    URL.revokeObjectURL(url); setBackup(true);
  }
  async function change(rollback: boolean) {
    if (!before || busy || (!rollback && (!backup || !ack || !proposed))) return;
    const expected = rollback ? after : before;
    if (!expected || (rollback && !verified) || (!rollback && attempted)) return;
    setBusy(true);
    let putAttempted = false;
    try {
      const current = await read();
      if (stablePolicyJson(current) !== stablePolicyJson(expected)) throw new Error("Combo changed since observation. No write sent; reload and review.");
      const body = rollback ? { allowedProviders: before.allowedProviders, config: before.config } : proposed!;
      putAttempted = true; setAttempted(true); setVerified(false);
      let status = "transport outcome unknown";
      let accepted = false;
      try {
        const result = await fetch(endpoint, { method: "PUT", credentials: "same-origin", redirect: "error", signal: AbortSignal.timeout(15000),
          headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
        status = `HTTP ${result.status}`; accepted = result.ok;
      } catch { /* An ambiguous write must be read back, never retried automatically. */ }
      const observed = await read();
      const wanted = { ...expected, ...body };
      setAfter(observed);
      if (!policySnapshotMatches(observed, wanted)) {
        setMessage(`Save outcome ${status}; readback differs. No retry. Automatic rollback is unavailable because unrelated state may differ. Preserve both snapshots for review.`); return;
      }
      if (!accepted) {
        setMessage(`Management write ${status}; desired state is visible, but this write is not confirmed. No retry or automatic rollback.`); return;
      }
      setVerified(true);
      if (rollback) { setBefore(observed); setAfter(null); setVerified(false); setAttempted(false); setBackup(false); setAck(false); }
      setMessage(rollback ? "Previous configuration restored and read back." : "Policy saved and read back. This is not inference acceptance.");
    } catch (e) {
      setMessage((e instanceof Error ? e.message : "Management operation failed.") + (putAttempted ? " Write may have completed; do not retry blindly. Reload/read back first." : ""));
    } finally { setBusy(false); }
  }
  return <section className="rounded-xl border border-border p-5 space-y-3" aria-label="Central auto routing policy">
    <h2 className="text-lg font-semibold">Central auto routing policy</h2>
    <p>Edits this existing model-free auto combo through the authenticated management API. No model pin, key access, or inference. Existing cloud sync runs on save; account for its current destination before proceeding. The fresh-state check detects observed drift but is not an atomic revision lock; coordinate other writers.</p>
    <button type="button" disabled={busy} onClick={() => void load()}>Reload current policy</button>
    {issue ? <p role="alert">{issue}</p> : <>
      <p>Effective source: config (no higher-precedence override). Strategy: auto; explicit models: 0. Revision: {String(before?.updatedAt || "not reported")}</p>
      <label className="block">Allowed providers <input className="w-full border p-2" value={allowed} disabled={busy || !!after} onChange={e => setAllowed(e.target.value)} /></label>
      <label className="block">Zero-additional-cost eligible providers <input className="w-full border p-2" value={zeroCost} disabled={busy || !!after} onChange={e => setZeroCost(e.target.value)} /></label>
      <p>Selection: fit-first-free. Budget fallback: strict. Exploration: 0. Local fallback: last. Compatibility fail-open: false. Provider membership alone does not prove free entitlement.</p>
      <label className="block"><input type="checkbox" checked={trial} disabled={busy || !!after} onChange={e => setTrial(e.target.checked)} /> Explicit prototype/development usage only (permits eligible standard hosted NVIDIA trial; not production traffic).</label>
      <label className="block"><input type="checkbox" checked={ack} disabled={busy || !!after} onChange={e => setAck(e.target.checked)} /> I reviewed the exact delta and existing cloud-sync effects. No other writer is changing this combo.</label>
      <details><summary>Complete observed configuration / rollback snapshot</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(before, null, 2)}</pre></details>
      <details><summary>Exact proposed management fields</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(proposed, null, 2)}</pre></details>
      {draftIssue && <p role="alert">{draftIssue}</p>}
      <button type="button" disabled={busy} onClick={downloadBackup}>Download before snapshot</button>{" "}
      <button type="button" disabled={busy || !backup || !ack || !proposed || attempted} onClick={() => void change(false)}>Save central policy</button>{" "}
      <button type="button" disabled={busy || !after || !verified} onClick={() => void change(true)}>Restore observed previous policy</button>
      {after && <details open><summary>Actual readback</summary><pre className="whitespace-pre-wrap break-all">{JSON.stringify(after, null, 2)}</pre></details>}
    </>}
    {message && <p role="status">{message}</p>}
  </section>;
}
