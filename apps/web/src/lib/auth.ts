import { auth, currentUser } from "@clerk/nextjs/server";
import { eq } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db/client";
import { users } from "@/db/schema";
import type { UserRole } from "./types";

export type Actor = {
  id: string | null;
  clerkId: string;
  email: string;
  displayName: string;
  role: UserRole;
};

const ownerEmail = () =>
  (process.env.OWNER_EMAIL ?? "owner@example.com").toLowerCase();

export function hasClerk() {
  return Boolean(
    process.env.NEXT_PUBLIC_CLERK_PUBLISHABLE_KEY && process.env.CLERK_SECRET_KEY,
  );
}

export async function getActor(): Promise<Actor> {
  if (!hasClerk()) {
    return {
      id: null,
      clerkId: "demo-owner",
      email: ownerEmail(),
      displayName: "Owner",
      role: "owner",
    };
  }

  const session = await auth();
  if (!session.userId) {
    return { id: null, clerkId: "", email: "", displayName: "", role: "pending" };
  }

  const clerkUser = await currentUser();
  const email =
    clerkUser?.primaryEmailAddress?.emailAddress?.toLowerCase() ?? "unknown";
  const displayName =
    clerkUser?.fullName ?? clerkUser?.username ?? email.split("@")[0];
  const forcedRole: UserRole | null = email === ownerEmail() ? "owner" : null;

  if (!hasDatabase()) {
    return {
      id: null,
      clerkId: session.userId,
      email,
      displayName,
      role: forcedRole ?? "pending",
    };
  }

  const db = getDb();
  const existing = await db.query.users.findFirst({
    where: eq(users.clerkId, session.userId),
  });
  const role = forcedRole ?? existing?.role ?? "pending";

  if (!existing) {
    const [created] = await db
      .insert(users)
      .values({ clerkId: session.userId, email, displayName, role })
      .onConflictDoNothing()
      .returning();
    return { id: created?.id ?? null, clerkId: session.userId, email, displayName, role };
  }

  return { id: existing.id, clerkId: session.userId, email, displayName, role };
}

export async function requireMember() {
  const actor = await getActor();
  if (actor.role !== "member" && actor.role !== "owner") throw new Error("FORBIDDEN");
  return actor;
}
