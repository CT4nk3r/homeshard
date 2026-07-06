import { count, desc, eq, isNull, ne, sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db/client";
import { alerts, hosts, instances, users } from "@/db/schema";
import type { Actor } from "./auth";
import type { DashboardSnapshot, InstanceState } from "./types";
import { agentLastSeenLabel, isAgentOnline } from "./agent-status";

export async function getDashboardSnapshot(actor: Actor): Promise<DashboardSnapshot> {
  if (!hasDatabase()) {
    return {
      demoMode: true,
      actor: { email: actor.email, role: actor.role, displayName: actor.displayName },
      host: {
        status: "demo",
        name: "homeserver",
        agentId: "demo",
        magicDnsName: "",
        lastSeenAt: null,
        lastSeenLabel: "Demo mode",
        memoryUsedGb: 3.6,
        memoryTotalGb: 31,
        nvmeFreeGb: 99,
        coldUsedGb: 0,
        coldLimitGb: 500,
      },
      instances: [
        {
          id: "demo-two-week",
          name: "TwoWeekMc",
          state: "sleeping",
          serverType: "Fabric",
          gameVersion: "1.21.1",
          worldSeed: null,
          port: 25600,
          memoryMb: 8192,
          players: 0,
          maxPlayers: 20,
        },
      ],
      pendingUsers: 0,
      activeAlerts: 0,
    };
  }

  const db = getDb();
  const [host, rows, [pending], [activeAlerts]] = await Promise.all([
    db.query.hosts.findFirst({
      orderBy: [sql`${hosts.lastSeenAt} DESC NULLS LAST`, desc(hosts.createdAt)],
    }),
    db.select().from(instances).where(ne(instances.state, "trashed")).orderBy(desc(instances.createdAt)),
    db.select({ value: count() }).from(users).where(eq(users.role, "pending")),
    db.select({ value: count() }).from(alerts).where(isNull(alerts.acknowledgedAt)),
  ]);
  const metrics = (host?.metrics ?? {}) as Record<string, unknown>;
  const numberMetric = (name: string, fallback: number) =>
    typeof metrics[name] === "number" ? metrics[name] : fallback;
  const now = new Date();

  return {
    demoMode: false,
    actor: { email: actor.email, role: actor.role, displayName: actor.displayName },
    host: {
      status: isAgentOnline(host?.lastSeenAt, now) ? "online" : "offline",
      name: host?.name ?? "homeserver",
      agentId: host?.agentId ?? "unregistered",
      magicDnsName: host?.magicDnsName ?? "",
      lastSeenAt: host?.lastSeenAt?.toISOString() ?? null,
      lastSeenLabel: agentLastSeenLabel(host?.lastSeenAt, now),
      memoryUsedGb: numberMetric("memoryUsedGb", 0),
      memoryTotalGb: numberMetric("memoryTotalGb", 31),
      nvmeFreeGb: numberMetric("nvmeFreeGb", 0),
      coldUsedGb: numberMetric("coldUsedGb", 0),
      coldLimitGb: 500,
    },
    instances: rows.map((instance) => {
      const status = instance.status as Record<string, unknown>;
      return {
        id: instance.id,
        name: instance.name,
        state: instance.state as InstanceState,
        serverType: instance.serverType,
        gameVersion: instance.gameVersion,
        worldSeed: instance.worldSeed,
        port: instance.port,
        memoryMb: instance.memoryMb,
        players: typeof status.players === "number" ? status.players : 0,
        maxPlayers: typeof status.maxPlayers === "number" ? status.maxPlayers : 20,
        reason: typeof status.reason === "string" ? status.reason : undefined,
      };
    }),
    pendingUsers: pending?.value ?? 0,
    activeAlerts: activeAlerts?.value ?? 0,
  };
}
