CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"name" text NOT NULL,
	"transport" text DEFAULT 'streamable_http' NOT NULL,
	"url" text NOT NULL,
	"headers_encrypted" text,
	"enabled" boolean DEFAULT true NOT NULL,
	"allow_private" boolean DEFAULT false NOT NULL,
	"last_status" text DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"last_checked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "mcp_servers" ADD CONSTRAINT "mcp_servers_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_userId_idx" ON "mcp_servers" USING btree ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "mcp_servers_userId_name_idx" ON "mcp_servers" USING btree ("user_id","name");