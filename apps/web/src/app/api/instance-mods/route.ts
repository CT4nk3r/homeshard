import { stat } from "node:fs/promises";
import path from "node:path";
import { NextResponse } from "next/server";
import { z } from "zod";
import { requireMember } from "@/lib/auth";
import { enqueueCommand } from "@/lib/commands";
import { MAX_INSTANCE_MOD_BYTES, safeJarName } from "@/lib/instance-mods";

const sourceSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("local"),
    path: z.string(),
    originalName: z.string(),
    sizeBytes: z.number().int().positive().max(MAX_INSTANCE_MOD_BYTES),
    sha256: z.string().length(64),
  }),
  z.object({
    kind: z.literal("url"),
    url: z.string().url(),
    originalName: z.string(),
  }),
]);

const addModSchema = z.object({
  instanceId: z.string().uuid(),
  source: sourceSchema,
});

export async function POST(request: Request) {
  try {
    const actor = await requireMember();
    const input = addModSchema.parse(await request.json());
    const source = input.source;

    if (source.kind === "local") {
      const root = process.env.HOMESHARD_LOCAL_STAGING_DIR;
      if (!root) throw new Error("Local staging is disabled");
      const resolvedRoot = path.resolve(root);
      const resolvedFile = path.resolve(source.path);
      if (!resolvedFile.startsWith(`${resolvedRoot}${path.sep}`)) throw new Error("Invalid staging path");
      const info = await stat(resolvedFile);
      if (info.size !== source.sizeBytes) throw new Error("Staged mod size changed");
    }

    if (source.kind === "url") {
      const parsed = new URL(source.url);
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        throw new Error("Mod URL must use http or https");
      }
    }

    source.originalName = safeJarName(source.originalName);
    const command = await enqueueCommand({
      actor,
      instanceId: input.instanceId,
      kind: "add_instance_mod",
      payload: { source },
    });
    return NextResponse.json(command, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not add mod";
    const publicMessage = message.startsWith("Failed query:") ? "Could not queue mod install" : message;
    return NextResponse.json(
      { error: publicMessage },
      { status: message === "FORBIDDEN" ? 403 : 400 },
    );
  }
}
