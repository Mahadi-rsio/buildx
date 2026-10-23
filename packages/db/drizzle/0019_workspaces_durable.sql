ALTER TABLE "workspaces" DROP CONSTRAINT IF EXISTS "workspaces_user_id_unique";
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "box_id" text;
--> statement-breakpoint
ALTER TABLE "workspaces" ADD COLUMN IF NOT EXISTS "slug" text;
--> statement-breakpoint
UPDATE "workspaces" SET "slug" = lower(replace("name", ' ', '-')) WHERE "slug" IS NULL;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "workspaces_slug_idx" ON "workspaces" USING btree ("slug");
--> statement-breakpoint
UPDATE "workspaces" SET "status" = 'provisioning' WHERE "status" NOT IN ('provisioning', 'ready', 'failed', 'recovering', 'deleting');
--> statement-breakpoint
ALTER TABLE "workspaces" ALTER COLUMN "status" SET DEFAULT 'provisioning';
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "workspaces_name_user_idx" ON "workspaces" USING btree ("name", "user_id");
--> statement-breakpoint
DROP INDEX IF EXISTS "workspaces_status_idx";
--> statement-breakpoint
CREATE INDEX "workspaces_status_idx" ON "workspaces" USING btree ("status");
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "fly_app";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "fly_volume_id";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "fly_machine_id";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "region";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "daemon_token_encrypted";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "last_active_at";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "last_synced_at";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "backup_bytes";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "backup_sha256";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "image_digest";
--> statement-breakpoint
ALTER TABLE "workspaces" DROP COLUMN IF EXISTS "lockfile_hash";
