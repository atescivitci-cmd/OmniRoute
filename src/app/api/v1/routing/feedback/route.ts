import { z } from "zod";
import { getApiKeyRequestScope } from "@/app/api/v1/_helpers/apiKeyScope";
import { validateApiKey } from "@/lib/db/apiKeys";
import { recordAnswerQuality } from "@/lib/db/answerQuality";
import { buildErrorBody } from "@omniroute/open-sse/utils/error.ts";
const schema = z
  .object({
    receipt: z.string().uuid(),
    accepted: z.boolean(),
    reason: z.enum([
      "accepted",
      "model_output_invalid",
      "model_evidence_invalid",
      "model_price_invalid",
      "tool_arguments_invalid",
      "gateway_shape",
      "source_validation_failed",
    ]),
  })
  .strict();
export async function POST(request: Request) {
  const scope = await getApiKeyRequestScope(request);
  if (!scope.apiKeyId || !scope.apiKey || !(await validateApiKey(scope.apiKey)))
    return Response.json(buildErrorBody(401, "API key required"), { status: 401 });
  if (Number(request.headers.get("content-length") ?? 0) > 2048)
    return Response.json(buildErrorBody(413, "Feedback too large"), { status: 413 });
  const raw = await request.text();
  if (raw.length > 2048)
    return Response.json(buildErrorBody(413, "Feedback too large"), { status: 413 });
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return Response.json(buildErrorBody(400, "Invalid feedback"), { status: 400 });
  }
  const p = schema.safeParse(value);
  if (!p.success || p.data.accepted !== (p.data.reason === "accepted"))
    return Response.json(buildErrorBody(400, "Invalid feedback"), { status: 400 });
  try {
    const status = recordAnswerQuality(
      scope.apiKeyId,
      p.data.receipt,
      p.data.accepted,
      p.data.reason
    );
    return Response.json({ status }, { status: status === "missing" ? 404 : 200 });
  } catch {
    return Response.json(buildErrorBody(503, "Feedback unavailable"), { status: 503 });
  }
}
