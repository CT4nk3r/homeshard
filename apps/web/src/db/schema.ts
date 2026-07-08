import {
  bigint,
  boolean,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from "drizzle-orm/pg-core";

export const userRole = pgEnum("user_role", ["pending", "member", "owner"]);
export const gameId = pgEnum("game_id", ["minecraft", "terraria", "valheim"]);
export const instanceState = pgEnum("instance_state", [
  "deploying",
  "running",
  "sleeping",
  "stopped",
  "failed",
  "trashed",
]);
export const commandStatus = pgEnum("command_status", [
  "queued",
  "claimed",
  "succeeded",
  "failed",
]);

export const users = pgTable(
  "users",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    clerkId: text("clerk_id").notNull(),
    email: text("email").notNull(),
    displayName: text("display_name"),
    role: userRole("role").notNull().default("pending"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("users_clerk_id_unique").on(table.clerkId),
    uniqueIndex("users_email_unique").on(table.email),
  ],
);

export const hosts = pgTable("hosts", {
  id: uuid("id").defaultRandom().primaryKey(),
  name: text("name").notNull().default("homeserver"),
  agentId: text("agent_id").notNull().unique(),
  magicDnsName: text("magic_dns_name").notNull(),
  status: text("status").notNull().default("offline"),
  metrics: jsonb("metrics").$type<Record<string, unknown>>().notNull().default({}),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const instances = pgTable(
  "instances",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    hostId: uuid("host_id").references(() => hosts.id),
    createdBy: uuid("created_by").references(() => users.id),
    game: gameId("game").notNull().default("minecraft"),
    name: text("name").notNull(),
    slug: text("slug").notNull(),
    state: instanceState("state").notNull().default("deploying"),
    port: integer("port").notNull(),
    serverType: text("server_type").notNull().default("VANILLA"),
    gameVersion: text("game_version").notNull().default("LATEST"),
    worldSeed: text("world_seed"),
    memoryMb: integer("memory_mb").notNull().default(4096),
    idleTimeoutSeconds: integer("idle_timeout_seconds").notNull().default(600),
    status: jsonb("status").$type<Record<string, unknown>>().notNull().default({}),
    trashedAt: timestamp("trashed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("instances_slug_unique").on(table.slug),
    uniqueIndex("instances_port_unique").on(table.port),
    index("instances_state_idx").on(table.state),
  ],
);

export const packRevisions = pgTable(
  "pack_revisions",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    originalName: text("original_name").notNull(),
    sha256: text("sha256"),
    blobUrl: text("blob_url"),
    coldPath: text("cold_path"),
    manifest: jsonb("manifest").$type<Record<string, unknown>>().notNull().default({}),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    active: boolean("active").notNull().default(false),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("pack_revisions_instance_idx").on(table.instanceId)],
);

export const instanceMods = pgTable(
  "instance_mods",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }).notNull(),
    filename: text("filename").notNull(),
    enabled: boolean("enabled").notNull().default(true),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull().default(0),
    updatedAt: timestamp("updated_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex("instance_mods_instance_filename_unique").on(table.instanceId, table.filename),
    index("instance_mods_instance_idx").on(table.instanceId),
  ],
);

export const instanceBackups = pgTable(
  "instance_backups",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }).notNull(),
    kind: text("kind").notNull(),
    coldPath: text("cold_path").notNull(),
    sizeBytes: bigint("size_bytes", { mode: "number" }).notNull(),
    worldSeed: text("world_seed"),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("instance_backups_instance_created_idx").on(table.instanceId, table.createdAt)],
);

export const commands = pgTable(
  "commands",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    instanceId: uuid("instance_id").references(() => instances.id, { onDelete: "cascade" }),
    requestedBy: uuid("requested_by").references(() => users.id),
    kind: text("kind").notNull(),
    payload: jsonb("payload").$type<Record<string, unknown>>().notNull().default({}),
    status: commandStatus("status").notNull().default("queued"),
    result: jsonb("result").$type<Record<string, unknown>>(),
    error: text("error"),
    claimedBy: text("claimed_by"),
    availableAt: timestamp("available_at", { withTimezone: true }).notNull().defaultNow(),
    claimedAt: timestamp("claimed_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    index("commands_claim_idx").on(table.status, table.availableAt, table.createdAt),
    index("commands_instance_idx").on(table.instanceId, table.createdAt),
  ],
);

export const alerts = pgTable("alerts", {
  id: uuid("id").defaultRandom().primaryKey(),
  severity: text("severity").notNull(),
  title: text("title").notNull(),
  message: text("message").notNull(),
  acknowledgedAt: timestamp("acknowledged_at", { withTimezone: true }),
  createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
});

export const auditEvents = pgTable(
  "audit_events",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    actorId: uuid("actor_id").references(() => users.id),
    action: text("action").notNull(),
    resourceType: text("resource_type").notNull(),
    resourceId: text("resource_id"),
    summary: text("summary").notNull(),
    metadata: jsonb("metadata").$type<Record<string, unknown>>().notNull().default({}),
    createdAt: timestamp("created_at", { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [index("audit_created_idx").on(table.createdAt)],
);
