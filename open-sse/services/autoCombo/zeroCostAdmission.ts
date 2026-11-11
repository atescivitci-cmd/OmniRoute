import { AsyncLocalStorage } from 'node:async_hooks';
import { resolveConfiguredNvidiaTrial } from './configuredNvidiaTrial.ts';
/**
 * Server-owned evidence seam. NEVER populate from caller headers/body, catalog
 * price labels, or provider name. Concrete native-local and explicitly scoped
 * NVIDIA hosted-trial resolvers are available; other cloud economics remain denied.
 */
export type ZeroCostRequest = {
  provider: string; model: string; connectionId: string;
  body: Readonly<Record<string, unknown>>;
  effectiveChatUrl?: string;
  signal?: AbortSignal;
};
export type ZeroCostEvidence = {
  provider: string; model: string; connectionId: string;
  noAdditionalCost: true; validUntilMs?: number; evidenceId: string;
  /** Native-local proof may bind this exact in-process invocation instead of a TTL. */
  request?: ZeroCostRequest;
};
export type ZeroCostEvidenceResolver = (request: ZeroCostRequest) => ZeroCostEvidence | null | Promise<ZeroCostEvidence | null>;
let trustedResolver: ZeroCostEvidenceResolver | null = null;
/** Trusted server startup only; not an HTTP/config/plugin API or authorization grant. */
export function installZeroCostEvidenceResolver(resolver: ZeroCostEvidenceResolver): void {
  if (trustedResolver !== null) throw new Error('zero_cost_resolver_already_installed');
  trustedResolver = resolver;
}
export function validZeroCostEvidence(request: ZeroCostRequest, evidence: ZeroCostEvidence | null, now = Date.now()): boolean {
  return !!evidence && evidence.noAdditionalCost === true &&
    evidence.provider === request.provider && evidence.model === request.model &&
    evidence.connectionId === request.connectionId &&
    typeof evidence.evidenceId === 'string' && evidence.evidenceId.length > 0 && evidence.evidenceId.length <= 256 &&
    (evidence.request === request ||
      (Number.isFinite(evidence.validUntilMs) && evidence.validUntilMs! > now));
}
export async function hasCurrentZeroCostAdmission(request: ZeroCostRequest): Promise<boolean> {
  if (!request.provider || !request.model || !request.connectionId) return false;
  try {
    const evidence = trustedResolver ? await trustedResolver(request) : request.provider === 'ollama-local'
      ? await (await import('./configuredLocalOllama.ts')).resolveConfiguredLocalOllama(request)
      : request.provider === 'nvidia' ? await resolveConfiguredNvidiaTrial(request) : null;
    return validZeroCostEvidence(request,evidence);
  } catch { return false; }
}
const dispatchPolicy = new AsyncLocalStorage<{scope: readonly string[]; provider:string}>();
export async function assertFinalCostDispatch(request: ZeroCostRequest, options: RequestInit & {dispatcher?:unknown}): Promise<void> {
  const policy = dispatchPolicy.getStore();
  if (!policy) return;
  if (request.provider !== policy.provider || !selectedConnectionIsInScope(request.connectionId,[...policy.scope]) ||
      options.dispatcher !== undefined || !await hasCurrentZeroCostAdmission(request)) throw new ZeroCostAdmissionError();
}
export function isCostDispatchRequired(): boolean { return dispatchPolicy.getStore() !== undefined; }
/** Strict scope: null means no extra restriction; [] means NO accounts. */
export function intersectStrictConnectionScope(first: string[] | null, second: string[] | null): string[] | null {
  if (first === null) return second === null ? null : [...second];
  if (second === null) return [...first];
  return first.filter(id => second.includes(id));
}
export function selectedConnectionIsInScope(connectionId: unknown, scope: string[] | null, forced?: string | null): boolean {
  return typeof connectionId === 'string' && connectionId.length > 0 &&
    (scope === null || scope.includes(connectionId)) && (!forced || forced === connectionId);
}

export const LOCAL_COST_ERROR_CODES = new Set(['zero_cost_admission_unavailable', 'connection_scope_empty', 'connection_scope_mismatch']);
export function zeroCostErrorResponse(status: number, message: string, classification: {code: string}): Response {
  const code = LOCAL_COST_ERROR_CODES.has(classification.code) ? classification.code : 'zero_cost_admission_unavailable';
  return new Response(JSON.stringify({error:{message,code,type:'local_cost_admission'}}), {status,headers:{'Content-Type':'application/json'}});
}
export class ZeroCostAdmissionError extends Error {
  readonly code = 'zero_cost_admission_unavailable';
  constructor(){ super('Current model/account/request cost admission is unverified'); }
}
export function zeroCostErrorResult(error: ZeroCostAdmissionError) {
  return {success:false,status:503,error:error.message,errorCode:error.code,errorType:'local_cost_admission',response:zeroCostErrorResponse(503,error.message,error)};
}
/** Last application-owned executor boundary; checks every actual retry model/body/account. */
export async function executeWithZeroCostAdmission<T>(
  required: boolean,
  scope: readonly string[] | null,
  provider: string,
  args: {model: string; body: Record<string,unknown>; credentials: {connectionId?: string}; signal?: AbortSignal},
  execute: () => Promise<T>,
): Promise<T> {
  if (required && (!selectedConnectionIsInScope(args.credentials?.connectionId, scope === null ? [] : [...scope]) ||
    !await hasCurrentZeroCostAdmission({provider,model:args.model,connectionId:args.credentials.connectionId!,body:args.body,signal:args.signal}))) {
    throw new ZeroCostAdmissionError();
  }
  return required ? dispatchPolicy.run({scope:[...scope!],provider},execute) : execute();
}
