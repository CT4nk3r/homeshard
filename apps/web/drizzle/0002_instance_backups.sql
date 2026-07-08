CREATE TABLE IF NOT EXISTS "instance_backups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL REFERENCES "public"."instances"("id") ON DELETE cascade,
	"kind" text NOT NULL,
	"cold_path" text NOT NULL,
	"size_bytes" bigint NOT NULL,
	"world_seed" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instance_backups_instance_created_idx" ON "instance_backups" USING btree ("instance_id", "created_at");
