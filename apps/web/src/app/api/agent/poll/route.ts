import { NextResponse } from "next/server";
import { getSql, hasDatabase } from "@/db/client";

function authorized(request: Request) {
  const expected = process.env.AGENT_TOKEN;
  return Boolean(expected && request.headers.get("authorization") === `Bearer ${expected}`);
}

export async function POST(request: Request) {
  if (!authorized(request)) return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  if (!hasDatabase()) return NextResponse.json({ command: null });

  const { agentId = "homeshard-agent" } = (await request.json()) as { agentId?: string };
  const sql = getSql();
  const rows = await sql`
    WITH next_command AS (
      SELECT id FROM commands
      WHERE status = 'queued' AND available_at <= now()
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    UPDATE commands
    SET status = 'claimed', claimed_by = ${agentId}, claimed_at = now()
    WHERE id = (SELECT id FROM next_command)
    RETURNING id, instance_id, kind, payload, created_at
  `;
  return NextResponse.json({ command: rows[0] ?? null });
}
