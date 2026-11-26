/**
 * API Route: /api/intelligence/sync
 *
 * POST — Trigger a manual Arena ELO intelligence sync and a manual LMArena quality-score sync
 *        (src/lib/qualityScoreSync.ts; the one-shot fill after install). 200 when either succeeds.
 * GET — Get current intelligence sync status; `qualityFeed` is the quality-score feed status
 *       (state fresh / stale / failing / never_synced, data age, last error).
 * DELETE — Clear all synced arena_elo intelligence data.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireManagementAuth } from "@/lib/api/requireManagementAuth";
import { intelligenceSyncRequestSchema } from "@/shared/validation/schemas";
import { isValidationFailure, validateBody } from "@/shared/validation/helpers";
import { sanitizeErrorMessage } from "@omniroute/open-sse/utils/error";

export async function POST(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json(
      {
        error: {
          message: "Invalid request",
          details: [{ field: "body", message: "Invalid JSON body" }],
        },
      },
      { status: 400 }
    );
  }

  try {
    const validation = validateBody(intelligenceSyncRequestSchema, rawBody);
    if (isValidationFailure(validation)) {
      return NextResponse.json({ error: validation.error }, { status: 400 });
    }
    const { dryRun = false } = validation.data;

    const { syncArenaElo } = await import("@/lib/arenaEloSync");
    const { syncQualityScores } = await import("@/lib/qualityScoreSync");
    const result = await syncArenaElo(dryRun);
    const qualityFeed = await syncQualityScores({ dryRun });

    return NextResponse.json(
      { ...result, qualityFeed },
      { status: result.success || qualityFeed.success ? 200 : 502 }
    );
  } catch (err) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(err) },
      { status: 500 }
    );
  }
}

export async function GET(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { getArenaEloSyncStatus } = await import("@/lib/arenaEloSync");
    const { getQualityScoreSyncStatus } = await import("@/lib/qualityScoreSync");
    return NextResponse.json({
      ...getArenaEloSyncStatus(),
      qualityFeed: getQualityScoreSyncStatus(),
    });
  } catch (err) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(err) },
      { status: 500 }
    );
  }
}

export async function DELETE(request: NextRequest) {
  const authError = await requireManagementAuth(request);
  if (authError) return authError;

  try {
    const { clearSyncedIntelligence } = await import("@/lib/arenaEloSync");
    clearSyncedIntelligence();
    return NextResponse.json({ success: true, message: "Synced intelligence data cleared" });
  } catch (err) {
    return NextResponse.json(
      { error: sanitizeErrorMessage(err) },
      { status: 500 }
    );
  }
}
