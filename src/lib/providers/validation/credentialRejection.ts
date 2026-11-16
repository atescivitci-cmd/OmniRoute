// Shared "HTTP 400 that is really a credential rejection" check for provider validators.
//
// Several validators treat a 400 on their chat probe as "reachable, auth ok" because some
// providers answer 400 to a probe model they do not serve even with a valid key. But a 400
// whose body says the Authorization header itself is badly formatted / malformed / invalid is
// the upstream refusing the credential at the auth layer, so the connection must NOT test as
// healthy. The wording check is the router's own (`isCredentialRejectionText`): a deliberately
// narrow explicit list, so every other 400 keeps its old "valid" meaning.
//
// Security: the result text is bounded (200 chars), passed through the repo error sanitizer,
// and scrubbed of anything key-shaped plus the exact key under test. Request headers are never
// read here. The upstream body is read through a clone and capped, never read in full.
import { isCredentialRejectionText } from "@omniroute/open-sse/services/combo/credentialRejection.ts";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error.ts";

const MAX_BODY_BYTES = 4096;
const MAX_EXCERPT_CHARS = 200;
const PREFIX = "credential rejected by upstream";

/** Anything that can report a status and (optionally) a body: a fetch Response or the
 *  `{ status, text() }` shape returned by `directHttpsRequest`. */
type ProbeResponse = {
  status: number;
  clone?: () => Response;
  text?: () => Promise<string>;
};

async function readBoundedText(response: ProbeResponse): Promise<string> {
  try {
    if (typeof response.clone === "function") {
      const body = response.clone().body;
      if (!body) return "";
      const reader = body.getReader();
      const decoder = new TextDecoder("utf-8", { fatal: false });
      let text = "";
      let bytes = 0;
      try {
        while (bytes < MAX_BODY_BYTES) {
          const { done, value } = await reader.read();
          if (done) break;
          bytes += value.byteLength;
          text += decoder.decode(value, { stream: true });
        }
      } finally {
        // Do NOT await: on a tee()'d clone the cancel promise only settles once the ORIGINAL
        // branch is cancelled as well, which would hang here while the caller still owns it.
        void reader.cancel().catch(() => undefined);
      }
      return text;
    }
    if (typeof response.text === "function") {
      return (await response.text()).slice(0, MAX_BODY_BYTES);
    }
  } catch {
    // Unreadable / already-consumed body: treat as no text (callers keep the legacy result).
  }
  return "";
}

function extractMessage(raw: string): string {
  try {
    const parsed: any = JSON.parse(raw);
    const candidates = [
      parsed?.error?.message,
      parsed?.message,
      typeof parsed?.error === "string" ? parsed.error : null,
      parsed?.detail,
      parsed?.msg,
    ];
    for (const candidate of candidates) {
      if (typeof candidate === "string" && isCredentialRejectionText(candidate)) return candidate;
    }
  } catch {
    // Not JSON (or truncated JSON): fall back to the raw text.
  }
  return raw;
}

function scrub(text: string, apiKey?: string): string {
  let out = text;
  if (typeof apiKey === "string" && apiKey.length >= 4) {
    out = out.split(apiKey).join("[REDACTED]");
  }
  out = sanitizeErrorMessage(out);
  return (
    out
      // JWT-like and provider-prefixed tokens, then any long opaque token.
      .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
      .replace(
        /\b(?:sk|pk|rk|ghp|gho|ghu|ghs|ghr|github_pat|xox[abprs]|AIza|ya29|key)[-_.][A-Za-z0-9_.-]{6,}/gi,
        "[REDACTED]"
      )
      .replace(/\b[A-Za-z0-9_-]{24,}\b/g, "[REDACTED]")
      .replace(/\s+/g, " ")
      .trim()
  );
}

/**
 * Returns an INVALID validation result when `response` is an HTTP 400 whose body text matches the
 * router's credential-rejection patterns, otherwise `null` (caller keeps its existing handling).
 * Only status 400 is considered; 401/403/422/429/5xx are left to the callers untouched.
 */
export async function credentialRejection400(
  response: ProbeResponse,
  options: { apiKey?: string } = {}
): Promise<{ valid: false; error: string } | null> {
  if (!response || response.status !== 400) return null;
  const raw = await readBoundedText(response);
  if (!raw || !isCredentialRejectionText(raw)) return null;
  const excerpt = scrub(extractMessage(raw), options.apiKey).slice(0, MAX_EXCERPT_CHARS);
  return { valid: false, error: `${PREFIX}: ${excerpt}` };
}
