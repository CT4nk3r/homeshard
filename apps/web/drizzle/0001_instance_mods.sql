ALTER TABLE "instances" ADD COLUMN IF NOT EXISTS "world_seed" text;--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "instance_mods" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"instance_id" uuid NOT NULL REFERENCES "public"."instances"("id") ON DELETE cascade,
	"filename" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"size_bytes" bigint DEFAULT 0 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "instance_mods_instance_filename_unique" ON "instance_mods" USING btree ("instance_id","filename");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "instance_mods_instance_idx" ON "instance_mods" USING btree ("instance_id");--> statement-breakpoint
