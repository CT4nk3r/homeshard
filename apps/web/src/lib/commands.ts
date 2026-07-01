import { getDb, hasDatabase } from "@/db/client";
import { auditEvents, commands } from "@/db/schema";
import type { Actor } from "./auth";

export async function enqueueCommand(input: {
  actor: Actor;
  instanceId?: string;
  kind: string;
  payload?: Record<string, unknown>;
}) {
  if (!hasDatabase()) return { id: crypto.randomUUID(), status: "queued", demo: true };
  const db = getDb();
  const [command] = await db
    .insert(commands)
    .values({
      instanceId: input.instanceId,
      ...(input.actor.id ? { requestedBy: input.actor.id } : {}),
      kind: input.kind,
      payload: input.payload ?? {},
    })
    .returning();
  await db.insert(auditEvents).values({
    ...(input.actor.id ? { actorId: input.actor.id } : {}),
    action: input.kind,
    resourceType: input.instanceId ? "instance" : "host",
    resourceId: input.instanceId,
    summary: `Queued ${input.kind}`,
  });
  return command;
}
