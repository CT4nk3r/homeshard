import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { z } from "zod";
import { getDb, hasDatabase } from "@/db/client";
import { commands } from "@/db/schema";
import { requireMember } from "@/lib/auth";
import { enqueueCommand } from "@/lib/commands";

const commandSchema = z.object({
  instanceId: z.string().optional(),
  kind: z.enum([
    "start",
    "stop",
    "restart",
    "sleep",
    "tail_logs",
    "console",
    "sync_mods",
    "set_instance_mods",
    "add_instance_mod",
    "delete_instance_mod",
    "create_instance",
    "retry_deploy",
    "import_local_world",
    "backup_instance",
    "regenerate_world",
    "restore_backup",
    "trash",
    "delete_instance",
  ]),
  payload: z.record(z.string(), z.unknown()).optional(),
});

export async function GET(request: Request) {
  try {
    await requireMember();
    const params = new URL(request.url).searchParams;
    const id = params.get("id");
    const instanceId = params.get("instanceId");
    if (!id && !instanceId) throw new Error("Command id or instance id is required");
    if (!hasDatabase()) {
      if (instanceId) return NextResponse.json({ commands: [], demo: true });
      return NextResponse.json({ id, status: "succeeded", result: { ok: true, data: {} }, demo: true });
    }
    if (instanceId) {
      const rows = await getDb()
        .select()
        .from(commands)
        .where(eq(commands.instanceId, instanceId))
        .orderBy(desc(commands.createdAt))
        .limit(12);
      return NextResponse.json({
        commands: rows.map((command) => ({
          id: command.id,
          kind: command.kind,
          status: command.status,
          instanceId: command.instanceId,
          error: command.error,
          result: command.result,
          claimedBy: command.claimedBy,
          createdAt: command.createdAt,
          availableAt: command.availableAt,
          claimedAt: command.claimedAt,
          completedAt: command.completedAt,
        })),
      });
    }
    if (!id) throw new Error("Command id is required");
    const command = await getDb().query.commands.findFirst({ where: eq(commands.id, id) });
    if (!command) return NextResponse.json({ error: "Command not found" }, { status: 404 });
    return NextResponse.json({
      id: command.id,
      kind: command.kind,
      status: command.status,
      instanceId: command.instanceId,
      error: command.error,
      result: command.result,
      claimedAt: command.claimedAt,
      completedAt: command.completedAt,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    return NextResponse.json(
      { error: message },
      { status: message === "FORBIDDEN" ? 403 : 400 },
    );
  }
}

export async function POST(request: Request) {
  try {
    const actor = await requireMember();
    const input = commandSchema.parse(await request.json());
    const command = await enqueueCommand({ actor, ...input });
    return NextResponse.json(command, { status: 202 });
  } catch (error) {
    const message = error instanceof Error ? error.message : "Invalid request";
    const publicMessage = message.startsWith("Failed query:") ? "Could not queue command" : message;
    return NextResponse.json(
      { error: publicMessage },
      { status: message === "FORBIDDEN" ? 403 : 400 },
    );
  }
}
