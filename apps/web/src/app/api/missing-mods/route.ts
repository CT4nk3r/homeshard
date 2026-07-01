import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { requireMember } from "@/lib/auth";

const MAX_MISSING_MOD_BYTES = 128 * 1024 * 1024;

export const runtime = "nodejs";

export async function POST(request: Request) {
  try {
    await requireMember();
    const root = process.env.HOMESHARD_MISSING_MODS_DIR;
    if (!root) return NextResponse.json({ error: "Missing-mod upload folder is disabled" }, { status: 404 });

    const form = await request.formData();
    const files = form.getAll("files");
    if (!files.length) throw new Error("At least one .jar file is required");

    await mkdir(root, { recursive: true });
    const uploaded = [];
    for (const item of files) {
      if (!(item instanceof File)) throw new Error("Missing mod upload must be a file");
      if (item.size > MAX_MISSING_MOD_BYTES) throw new Error(`${item.name} exceeds the 128 MB limit`);
      const filename = safeModArchiveName(item.name);
      const target = path.join(root, filename);
      await writeFile(target, new Uint8Array(await item.arrayBuffer()));
      uploaded.push({ filename, sizeBytes: item.size });
    }

    return NextResponse.json({ uploaded });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not upload missing mods";
    return NextResponse.json({ error: message }, { status: message === "FORBIDDEN" ? 403 : 400 });
  }
}

function safeModArchiveName(name: string) {
  const base = path.basename(name).replace(/[^a-zA-Z0-9._+-]+/g, "-");
  const lower = base.toLowerCase();
  if (!lower.endsWith(".jar") && !lower.endsWith(".zip")) {
    throw new Error("Missing mods must be .jar or .zip files");
  }
  return base.slice(0, 160);
}
