CREATE TYPE "public"."command_status" AS ENUM('queued', 'claimed', 'succeeded', 'failed');--> statement-breakpoint
CREATE TYPE "public"."game_id" AS ENUM('minecraft', 'terraria', 'valheim');--> statement-breakpoint
CREATE TYPE "public"."instance_state" AS ENUM('deploying', 'running', 'sleeping', 'stopped', 'failed', 'trashed');--> statement-breakpoint
CREATE TYPE "public"."user_role" AS ENUM('pending', 'member', 'owner');--> statement-breakpoint
CREATE TABLE "alerts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"severity" text NOT NULL,
	"title" text NOT NULL,
	"message" text NOT NULL,
	"acknowledged_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"actor_id" uuid,
	"action" text NOT NULL,
	"resource_type" text NOT NULL,
	"resource_id" text,
	"summary" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "commands" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid,
	"requested_by" uuid,
	"kind" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" "command_status" DEFAULT 'queued' NOT NULL,
	"result" jsonb,
	"error" text,
	"claimed_by" text,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"claimed_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hosts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text DEFAULT 'homeserver' NOT NULL,
	"agent_id" text NOT NULL,
	"magic_dns_name" text NOT NULL,
	"status" text DEFAULT 'offline' NOT NULL,
	"metrics" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "hosts_agent_id_unique" UNIQUE("agent_id")
);
--> statement-breakpoint
CREATE TABLE "instances" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"host_id" uuid,
	"created_by" uuid,
	"game" "game_id" DEFAULT 'minecraft' NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"state" "instance_state" DEFAULT 'deploying' NOT NULL,
	"port" integer NOT NULL,
	"server_type" text DEFAULT 'VANILLA' NOT NULL,
	"game_version" text DEFAULT 'LATEST' NOT NULL,
	"world_seed" text,
	"memory_mb" integer DEFAULT 4096 NOT NULL,
	"idle_timeout_seconds" integer DEFAULT 600 NOT NULL,
	"status" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"trashed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "instance_mods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL,
	"filename" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pack_revisions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid,
	"original_name" text NOT NULL,
	"sha256" text,
	"blob_url" text,
	"cold_path" text,
	"manifest" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"size_bytes" bigint NOT NULL,
	"active" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"clerk_id" text NOT NULL,
	"email" text NOT NULL,
	"display_name" text,
	"role" "user_role" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "audit_events" ADD CONSTRAINT "audit_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "commands" ADD CONSTRAINT "commands_requested_by_users_id_fk" FOREIGN KEY ("requested_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_host_id_hosts_id_fk" FOREIGN KEY ("host_id") REFERENCES "public"."hosts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instances" ADD CONSTRAINT "instances_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "instance_mods" ADD CONSTRAINT "instance_mods_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pack_revisions" ADD CONSTRAINT "pack_revisions_instance_id_instances_id_fk" FOREIGN KEY ("instance_id") REFERENCES "public"."instances"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_events" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "commands_claim_idx" ON "commands" USING btree ("status","available_at","created_at");--> statement-breakpoint
CREATE INDEX "commands_instance_idx" ON "commands" USING btree ("instance_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_slug_unique" ON "instances" USING btree ("slug");--> statement-breakpoint
CREATE UNIQUE INDEX "instances_port_unique" ON "instances" USING btree ("port");--> statement-breakpoint
CREATE INDEX "instances_state_idx" ON "instances" USING btree ("state");--> statement-breakpoint
CREATE UNIQUE INDEX "instance_mods_instance_filename_unique" ON "instance_mods" USING btree ("instance_id","filename");--> statement-breakpoint
CREATE INDEX "instance_mods_instance_idx" ON "instance_mods" USING btree ("instance_id");--> statement-breakpoint
CREATE INDEX "pack_revisions_instance_idx" ON "pack_revisions" USING btree ("instance_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_clerk_id_unique" ON "users" USING btree ("clerk_id");--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_unique" ON "users" USING btree ("email");