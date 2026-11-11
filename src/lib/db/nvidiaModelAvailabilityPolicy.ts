// Exact account/function negative evidence only; generic resource404/auth errors are not durable.
export function isNvidiaAccountFunctionMissing(
  provider: unknown,
  status: unknown,
  message: unknown
): boolean {
  if (
    provider !== "nvidia" ||
    status !== 404 ||
    typeof message !== "string" ||
    message.length > 8192
  ) {
    return false;
  }
  // parseUpstreamError retains the raw JSON for status/title/detail responses.
  // Recognize only the complete account/function template, never generic resource404.
  let detail = message;
  try {
    const parsed: unknown = JSON.parse(message);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return false;
    const body = parsed as { status?: unknown; detail?: unknown; title?: unknown };
    if (body.status !== 404 || typeof body.detail !== "string" ||
        !Object.keys(body).every((key) => key === "status" || key === "title" || key === "detail") ||
        (body.title !== undefined && body.title !== "Not Found")) return false;
    detail = body.detail;
  } catch {
    // The provider may also supply the same complete template as plain text.
  }
  const match =
    /^Function '[^'\x00-\x1f\x7f]{1,256}': Not found for account '[^'\x00-\x1f\x7f]{1,256}'$/i.exec(
      detail
    );
  return match !== null && match[0] === detail;
}
export function hasNvidiaIdentityUpdate(data: Record<string, unknown>): boolean {
  // Observe the configuration update event, never inspect/hash credential values.
  return ["provider", "authType", "apiKey", "accessToken", "refreshToken", "idToken"].some((k) =>
    Object.hasOwn(data, k)
  );
}
export const NVIDIA_MODEL_NEGATIVE_CODE = "nvidia_model_catalog_negative";
// Process-local provenance shared by joined requests; never inferred from provider headers/body.
export const LOCAL_NVIDIA_NEGATIVE_RESPONSES = new WeakSet<Response>();
