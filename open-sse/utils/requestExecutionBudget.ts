/** Optional caller execution bound, independent of model selection and cost policy.
 * It only adds cancellation; existing server/target deadlines still apply.
 * Consume the control locally so no provider sees an unknown wire header.
 */
const HEADER = "x-omniroute-request-timeout-ms";
export function withExecutionBudget(request: Request, body: unknown): Request {
  const value = request.headers.get(HEADER);
  if (value === null) return request;
  const headers = new Headers(request.headers);
  headers.delete(HEADER);
  headers.delete("content-length");
  const parsed = /^[1-9]\d{0,5}$/.test(value) ? Number(value) : null;
  const signal =
    parsed === null
      ? request.signal
      : AbortSignal.any([
          request.signal,
          AbortSignal.timeout(Math.max(250, Math.min(60000, parsed))),
        ]);
  return new Request(request.url, {
    method: request.method,
    headers,
    signal,
    body: JSON.stringify(body),
  });
}
