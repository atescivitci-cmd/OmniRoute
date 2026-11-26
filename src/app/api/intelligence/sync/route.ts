/**
 * API Route: /api/intelligence/sync
 *
 * POST — Trigger a manual LMArena quality-score sync (src/lib/qualityScoreSync.ts; the one-shot
 *        fill after install) and, independently and concurrently, the legacy Arena ELO sync.
 *        The HTTP status is the quality sync's: 409 while a sync (e.g. the boot sync) is already
 *        running, 200 on success, 502 on failure. Each feed reports its own result.
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
    const { manualQualitySync } = await import("@/lib/qualityScoreSync");
    const [quality, arena] = await Promise.all([
      manualQualitySync({ dryRun }),
      syncArenaElo(dryRun).catch((err) => ({
        success: false,
        modelCount: 0,
        source: "arena_elo",
        error: sanitizeErrorMessage(err),
      })),
    ]);
    if (quality.httpStatus === 409) {
      return NextResponse.json(
        {
          error: { message: "Quality score sync already in progress", code: "sync_in_progress" },
          qualityFeed: quality.result,
          arenaElo: arena,
        },
        { status: 409 }
      );
    }
    return NextResponse.json(
      { qualityFeed: quality.result, arenaElo: arena },
      { status: quality.httpStatus }
    );
  } catch (err) {
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
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
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
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
    return NextResponse.json({ error: sanitizeErrorMessage(err) }, { status: 500 });
  }
}
