import { desc, eq, sql } from "drizzle-orm";
import { getDb, hasDatabase } from "@/db/client";
import { hosts, instanceMods, instances, packRevisions } from "@/db/schema";
import type { InstanceState } from "./types";

export async function getInstanceDetail(id: string) {
  if (!hasDatabase()) {
    return {
      id,
      name: "TwoWeekMc",
      state: "sleeping" as InstanceState,
      port: 25600,
      serverType: "Fabric",
      gameVersion: "1.21.1",
      worldSeed: null,
      memoryMb: 8192,
      reason: undefined,
      magicDnsName: "",
      packs: [],
      mods: [],
    };
  }

  const db = getDb();
  const instance = await db.query.instances.findFirst({ where: eq(instances.id, id) });
  if (!instance) return null;
  const [packs, mods, host] = await Promise.all([
    db.select().from(packRevisions).where(eq(packRevisions.instanceId, id)).orderBy(desc(packRevisions.createdAt)),
    db.select().from(instanceMods).where(eq(instanceMods.instanceId, id)).orderBy(instanceMods.filename),
    instance.hostId
      ? db.query.hosts.findFirst({ where: eq(hosts.id, instance.hostId) })
      : db.query.hosts.findFirst({
          orderBy: [sql`${hosts.lastSeenAt} DESC NULLS LAST`, desc(hosts.createdAt)],
        }),
  ]);
  const status = instance.status as Record<string, unknown>;
  return {
    id: instance.id,
    name: instance.name,
    state: instance.state as InstanceState,
    port: instance.port,
    serverType: instance.serverType,
    gameVersion: instance.gameVersion,
    worldSeed: instance.worldSeed,
    memoryMb: instance.memoryMb,
    reason: typeof status.reason === "string" ? status.reason : undefined,
    magicDnsName: host?.magicDnsName ?? "",
    packs: packs.map((pack) => ({
      id: pack.id,
      originalName: pack.originalName,
      sha256: pack.sha256,
      sizeBytes: pack.sizeBytes,
      active: pack.active,
      downloadable: Boolean(pack.blobUrl || pack.coldPath),
    })),
    mods: mods.map((mod) => ({
      filename: mod.filename,
      enabled: mod.enabled,
      sizeBytes: mod.sizeBytes,
    })),
  };
}
