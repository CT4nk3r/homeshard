import { NextResponse } from "next/server";
import { z } from "zod";
import { getSql, hasDatabase } from "@/db/client";

const eventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("heartbeat"),
    agentId: z.string(),
    magicDnsName: z.string(),
    metrics: z.record(z.string(), z.unknown()),
  }),
  z.object({
    type: z.literal("command_result"),
    commandId: z.string().uuid(),
    success: z.boolean(),
    result: z.record(z.string(), z.unknown()).optional(),
    error: z.string().optional(),
  }),
  z.object({
    type: z.literal("instance_status"),
    instanceId: z.string().uuid(),
    state: z.enum(["deploying", "running", "sleeping", "stopped", "failed", "trashed"]),
    status: z.record(z.string(), z.unknown()),
  }),
]);

function authorized(request: Request) {
  const expected = process.env.AGENT_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  const event = eventSchema.parse(await request.json());
  if (!hasDatabase()) return NextResponse.json({ ok: true });
  const sql = getSql();

  if (event.type === "heartbeat") {
    await sql`
      INSERT INTO hosts (agent_id, name, magic_dns_name, status, metrics, last_seen_at)
      VALUES (${event.agentId}, ${event.agentId}, ${event.magicDnsName}, 'online', ${JSON.stringify(event.metrics)}::jsonb, now())
      ON CONFLICT (agent_id) DO UPDATE SET status = 'online', metrics = excluded.metrics, last_seen_at = now()
    `;
  }

  if (event.type === "command_result") {
    await sql`
      UPDATE commands SET
        status = ${event.success ? "succeeded" : "failed"}::command_status,
        result = ${JSON.stringify(event.result ?? {})}::jsonb,
        error = ${event.error ?? null},
        completed_at = now()
      WHERE id = ${event.commandId}
    `;
  }

  if (event.type === "instance_status") {
    await sql`
      UPDATE instances SET
        state = ${event.state}::instance_state,
        status = ${JSON.stringify(event.status)}::jsonb,
        updated_at = now()
      WHERE id = ${event.instanceId}
    `;
  }

  return NextResponse.json({ ok: true });
}
