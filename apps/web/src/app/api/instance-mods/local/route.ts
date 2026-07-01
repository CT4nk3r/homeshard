import { randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";
import { MAX_INSTANCE_MOD_BYTES, safeJarName, sha256 } from "@/lib/instance-mods";

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireMember();
    const root = process.env.HOMESHARD_LOCAL_STAGING_DIR;
    if (!root) return NextResponse.json({ error: "Local staging is disabled" }, { status: 404 });

    const form = await request.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new Error("Mod jar is required");
    if (file.size > MAX_INSTANCE_MOD_BYTES) throw new Error("Mod exceeds the 128 MB limit");

    const originalName = safeJarName(file.name);
    const bytes = new Uint8Array(await file.arrayBuffer());
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
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not stage mod";
    return NextResponse.json({ error: message }, { status: message === "FORBIDDEN" ? 403 : 400 });
  }
}
