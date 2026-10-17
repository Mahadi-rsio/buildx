ALTER TABLE "runs" ADD COLUMN "task" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "workspace_name" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "max_steps" integer DEFAULT 40 NOT NULL;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "updated_at" timestamp with time zone DEFAULT now() NOT NULL;