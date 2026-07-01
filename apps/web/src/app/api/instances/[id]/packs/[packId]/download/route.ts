import { createReadStream } from "node:fs";
import { stat } from "node:fs/promises";
import { Readable } from "node:stream";
import { and, eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { getDb, hasDatabase } from "@/db/client";
import { packRevisions } from "@/db/schema";
import { requireMember } from "@/lib/auth";
import { packContentType, resolveColdPackPath, safeDownloadName } from "@/lib/instance-files";

export const dynamic = "force-dynamic";

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string; packId: string }> },
) {
  try {
    await requireMember();
    const { id, packId } = await params;
    if (!hasDatabase()) {
      return NextResponse.json({ error: "Downloads require a database connection" }, { status: 404 });
    }

    const db = getDb();
    const pack = await db.query.packRevisions.findFirst({
      where: and(eq(packRevisions.id, packId), eq(packRevisions.instanceId, id)),
    });
    if (!pack) {
      return NextResponse.json({ error: "Pack revision not found" }, { status: 404 });
    }

    // Cloud staging keeps the pack in Vercel Blob; hand the client its URL.
    if (pack.blobUrl) {
      return NextResponse.redirect(pack.blobUrl);
    }
    if (!pack.coldPath) {
      return NextResponse.json({ error: "This pack revision has no stored file to download." }, { status: 404 });
    }

    const file = resolveColdPackPath(pack.coldPath);
    const info = await stat(file).catch(() => null);
    if (!info?.isFile()) {
      return NextResponse.json({ error: "The pack file is missing from storage." }, { status: 404 });
    }

    const filename = safeDownloadName(pack.originalName, "modpack.zip");
    const body = Readable.toWeb(createReadStream(file)) as ReadableStream<Uint8Array>;
    return new Response(body, {
      headers: {
        "content-type": packContentType(pack.originalName),
        "content-length": String(info.size),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not download pack";
    return NextResponse.json({ error: message }, { status: message === "FORBIDDEN" ? 403 : 400 });
  }
}
