/** Explicit client-version admission refusal; never a generic request/schema error. */
export function isClientVersionModelRejectionText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.slice(0, 2000);
  return /\b\d+\.\d+\.\d+\s+does not support this model;\s*version\s+\d+\.\d+\.\d+\s+or newer is required\b/i.test(
    text
  );
}

/** Explicit model/API support refusal, before generation. Request format errors remain terminal. */
export function isModelSupportRejectionText(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const text = value.slice(0, 2000);
  if (/\b(?:invalid|malformed)\s+(?:messages?|request body|json|format|schema)\b/i.test(text))
    return false;
  return (
    isClientVersionModelRejectionText(text) ||
    /\bmodel\b[^\n.!?]{0,80}\b(?:is\s+)?not\s+supported\b/i.test(text) ||
    /\bmodel\b[^\n.!?]{0,80}\bdoes\s+not\s+support\s+(?:the\s+)?responses\s+api\b/i.test(text) ||
    /\bunsupported_api_for_model\b/i.test(text)
  );
}
