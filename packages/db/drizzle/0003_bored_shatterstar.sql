CREATE TABLE "workspace_locks" (
	"workspace_id" text PRIMARY KEY NOT NULL,
	"lease_id" text NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_id" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "lease_expires_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancelled_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "cancel_reason" text;--> statement-breakpoint
ALTER TABLE "runs" ADD COLUMN "idempotency_key" text;--> statement-breakpoint
CREATE INDEX "workspace_locks_expiresAt_idx" ON "workspace_locks" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "runs_status_createdAt_idx" ON "runs" USING btree ("status","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "runs_idempotency_key_idx" ON "runs" USING btree ("user_id","idempotency_key") WHERE "runs"."idempotency_key" IS NOT NULL;