ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "checkpoint" jsonb;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "repository" text;
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN IF NOT EXISTS "task_branch" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "question" text;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "options" jsonb;
--> statement-breakpoint
ALTER TABLE "approvals" ADD COLUMN IF NOT EXISTS "answer" text;
