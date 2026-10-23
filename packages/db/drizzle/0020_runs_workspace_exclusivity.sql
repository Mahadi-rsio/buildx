ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "workspace_id" uuid;
--> statement-breakpoint
ALTER TABLE "runs" DROP CONSTRAINT IF EXISTS "runs_workspace_id_workspaces_id_fk";
--> statement-breakpoint
ALTER TABLE "runs" ADD CONSTRAINT "runs_workspace_id_workspaces_id_fk" FOREIGN KEY ("workspace_id") REFERENCES "workspaces"("id") ON DELETE SET NULL;
--> statement-breakpoint
DROP INDEX IF EXISTS "runs_one_active_per_user_idx";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "runs_one_active_per_workspace_idx" ON "runs" USING btree ("workspace_id") WHERE "status" = 'running';
