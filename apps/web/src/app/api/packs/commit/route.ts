import { stat } from "node:fs/promises";
import path from "node:path";
import { head } from "@vercel/blob";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { enqueueCommand } from "@/lib/commands";
import { MAX_PACK_BYTES, safeZipName } from "@/lib/packs";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    path: z.string(),
    originalName: z.string(),
    sizeBytes: z.number().int().positive().max(MAX_PACK_BYTES),
    sha256: z.string().length(64),
    summary: z.record(z.string(), z.unknown()).optional(),
  }),
  z.object({
    kind: z.literal("blob"),
    url: z.string().url(),
    pathname: z.string(),
    originalName: z.string(),
    sizeBytes: z.number().int().positive().max(MAX_PACK_BYTES),
  }),
]);

const commitSchema = z.object({
  name: z.string().trim().min(1).max(48),
  serverType: z.enum(["VANILLA", "PAPER", "FABRIC", "FORGE", "NEOFORGE"]),
  gameVersion: z.string().trim().min(1).max(32),
  levelSeed: z.string().trim().max(128).optional().transform((value) => value || undefined),
  memoryMb: z.number().int().min(2048).max(12288),
  packSource: sourceSchema.optional(),
});

export async function POST(request: Request) {
  try {
    const actor = await requireMember();
    const input = commitSchema.parse(await request.json());
    const source = input.packSource;

    if (source?.kind === "local") {
      const root = process.env.HOMESHARD_LOCAL_STAGING_DIR;
      if (!root) throw new Error("Local staging is disabled");
      const resolvedRoot = path.resolve(root);
      const resolvedFile = path.resolve(source.path);
      if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid staging path");
      const info = await stat(resolvedFile);
      if (info.size !== source.sizeBytes) throw new Error("Staged pack size changed");
    }

    if (source?.kind === "blob") {
      if (!source.pathname.startsWith("staging/packs/")) throw new Error("Invalid Blob staging path");
      const blob = await head(source.url);
      if (blob.pathname !== source.pathname || blob.size !== source.sizeBytes) {
        throw new Error("Blob metadata does not match");
      }
    }

    if (source) source.originalName = safeZipName(source.originalName);
    const command = await enqueueCommand({
      actor,
      kind: "create_instance",
      payload: input,
    });
    return NextResponse.json(command, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not commit pack";
    const publicMessage = message.startsWith("Failed query:") ? "Could not queue instance" : message;
    return NextResponse.json(
      { error: publicMessage },
      { status: message === "FORBIDDEN" ? 403 : 400 },
    );
  }
}
