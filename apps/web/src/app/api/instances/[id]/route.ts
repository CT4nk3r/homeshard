import { eq } from "drizzle-orm";
import { NextResponse } from "next/server";
import { z } from "zod";
import { getDb, hasDatabase } from "@/db/client";
import { auditEvents, instances } from "@/db/schema";
import { requireMember } from "@/lib/auth";

const renameSchema = z.object({
  name: z.string().trim().min(1, "Name is required").max(80, "Name must be 80 characters or fewer"),
});

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const actor = await requireMember();
    const { id } = await params;
    const instanceId = z.uuid().parse(id);
    const { name } = renameSchema.parse(await request.json());

    if (!hasDatabase()) return NextResponse.json({ id: instanceId, name, demo: true });

    const db = getDb();
    const [instance] = await db
      .update(instances)
      .set({ name, updatedAt: new Date() })
      .where(eq(instances.id, instanceId))
      .returning({ id: instances.id, name: instances.name });

    if (!instance) return NextResponse.json({ error: "Instance not found" }, { status: 404 });

    await db.insert(auditEvents).values({
      ...(actor.id ? { actorId: actor.id } : {}),
      action: "rename_instance",
      resourceType: "instance",
      resourceId: instanceId,
      summary: `Renamed instance to ${name}`,
    });

    return NextResponse.json(instance);
  } catch (error) {
    const message = error instanceof Error ? error.message : "Could not rename instance";
    return NextResponse.json(
      { error: message === "FORBIDDEN" ? "Forbidden" : message },
      { status: message === "FORBIDDEN" ? 403 : 400 },
    );
  }
}
