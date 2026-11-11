import { handleChat } from "@/sse/handlers/chat";
import { initTranslators } from "@omniroute/open-sse/translator/index.ts";
import { withInjectionGuard } from "@/middleware/promptInjectionGuard";
import { requireJsonContentType } from "@/shared/middleware/requireJsonContentType";
import {
  withEarlyStreamKeepalive,
  ANTHROPIC_PING_FRAME,
} from "@omniroute/open-sse/utils/earlyStreamKeepalive";
import { resolveKeepaliveThreshold } from "@omniroute/open-sse/utils/keepaliveThreshold";

let initialized = false;

/**
 * Initialize translators once
 */
async function ensureInitialized() {
  if (!initialized) {
    await initTranslators();
    initialized = true;
    console.log("[SSE] Translators initialized for /v1/messages");
  }
}

/**
 * Handle CORS preflight
 */
export async function OPTIONS() {
  return new Response(null, {
    headers: {
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "*",
    },
  });
}

/**
 * POST /v1/messages - Claude format (auto convert via handleChat)
 *
 * `preParsedBody` is threaded from withInjectionGuard (#4041) so the body is
 * parsed at most once per request.
 */
async function postHandler(request: any, context: any, preParsedBody: any = null) {
  // Reject non-JSON Content-Type with 415 before touching the body — mirrors OpenAI's
  // reference API and matches /v1/chat/completions (#6414).
  const ctRejection = requireJsonContentType(request);
  if (ctRejection) return ctRejection;

  await ensureInitialized();
  // Streaming Anthropic clients (Claude Code, the Anthropic SDK) drop the connection
  // when no bytes arrive while a large prompt is processed before the first token — a
  // big context can exceed the client's stream/first-token watchdog. OmniRoute holds
  // the response until the first useful upstream byte (ensureStreamReadiness), so keep
  // the connection warm with early keepalives during that gap — same wrapper used by
  // /v1/responses (#2544). Anthropic clients ignore SSE comments for their watchdog, so
  // emit a real `event: ping` (ANTHROPIC_PING_FRAME). Non-streaming callers keep the
  // verbatim path.
  const accept = String(request.headers?.get?.("accept") || "").toLowerCase();
  // The Anthropic SDK keeps Accept: application/json for stream:true requests.
  // Reuse the guarded parse; a clone fallback leaves the original body readable.
  let body = preParsedBody;
  if (body == null) {
    try {
      body = await request
        .clone()
        .json()
        .catch(() => null);
    } catch {
      // body unavailable / non-JSON — preserve handleChat's normal validation
    }
  }
  if (body?.stream === true || accept.includes("text/event-stream")) {
    return await withEarlyStreamKeepalive(handleChat(request, null, body), {
      signal: request.signal,
      thresholdMs: resolveKeepaliveThreshold(body?.model),
      keepaliveFrame: ANTHROPIC_PING_FRAME,
    });
  }
  // Pressed supplies one fresh ID per upstream call for observability only.
  // Keep streaming, other models, auth, session affinity and idempotency unchanged.
  const pressedCallId = request.headers?.get?.("x-pressed-call-id");
  if (
    body?.model === "ac-pressed-zero-token-cost" &&
    body?.stream === false &&
    typeof pressedCallId === "string" &&
    pressedCallId.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(pressedCallId)
  ) {
    return await handleChat(request, null, body, pressedCallId);
  }
  return await handleChat(request, null, body);
}

export const POST = withInjectionGuard(postHandler);
