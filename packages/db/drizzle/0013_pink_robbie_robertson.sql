CREATE TABLE "skill_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" text NOT NULL,
	"project_id" uuid,
	"skill_id" uuid NOT NULL,
	"name" text NOT NULL,
	"scope_key" text NOT NULL,
	"state" text DEFAULT 'installing' NOT NULL,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "skills" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"description" text NOT NULL,
	"source" text NOT NULL,
	"source_kind" text NOT NULL,
	"resolved_ref" text NOT NULL,
	"digest" text NOT NULL,
	"artifact_key" text NOT NULL,
	"file_count" integer DEFAULT 0 NOT NULL,
	"total_bytes" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_project_id_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."projects"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "skill_installations" ADD CONSTRAINT "skill_installations_skill_id_skills_id_fk" FOREIGN KEY ("skill_id") REFERENCES "public"."skills"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "skill_installations_scope_name_idx" ON "skill_installations" USING btree ("scope_key","name");--> statement-breakpoint
CREATE INDEX "skill_installations_userId_idx" ON "skill_installations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "skill_installations_projectId_idx" ON "skill_installations" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "skills_digest_idx" ON "skills" USING btree ("digest");--> statement-breakpoint
CREATE INDEX "skills_name_idx" ON "skills" USING btree ("name");