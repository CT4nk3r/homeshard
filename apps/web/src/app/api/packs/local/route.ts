import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";
import { inspectPack, MAX_PACK_BYTES, safeZipName, sha256 } from "@/lib/packs";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireMember();
    const root = process.env.HOMESHARD_LOCAL_STAGING_DIR;
    if (!root) return NextResponse.json({ error: "Local staging is disabled" }, { status: 404 });

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Pack ZIP is required");
    if (file.size > MAX_PACK_BYTES) throw new Error("Pack exceeds the 250 MB limit");

    const originalName = safeZipName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
    const summary = inspectPack(bytes);
    const digest = sha256(bytes);
    await mkdir(root, { recursive: true });
    const stagedPath = path.join(root, `${randomUUID()}-${originalName}`);
    await writeFile(stagedPath, bytes, { flag: "wx" });

    return NextResponse.json({
      kind: "local",
      path: stagedPath,
      originalName,
      sizeBytes: file.size,
      sha256: digest,
      summary,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stage pack";
    return NextResponse.json({ error: message }, { status: 400 });
  }
}
