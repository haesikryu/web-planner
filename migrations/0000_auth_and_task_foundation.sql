CREATE TABLE "identities" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"subject" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"id_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"password" text,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	CONSTRAINT "identity_subject_unique" UNIQUE("provider_id","subject"),
	CONSTRAINT "google_only" CHECK ("identities"."provider_id" = 'google'),
	CONSTRAINT "no_provider_credentials" CHECK ("identities"."access_token" IS NULL AND "identities"."refresh_token" IS NULL AND "identities"."id_token" IS NULL AND "identities"."password" IS NULL)
);
--> statement-breakpoint
CREATE TABLE "idempotency_records" (
	"owner_id" text NOT NULL,
	"method" text NOT NULL,
	"path" text NOT NULL,
	"key" text NOT NULL,
	"request_hash" text NOT NULL,
	"state" text NOT NULL,
	"response" jsonb,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "idempotency_records_owner_id_method_path_key_pk" PRIMARY KEY("owner_id","method","path","key"),
	CONSTRAINT "request_hash" CHECK ("idempotency_records"."request_hash" ~ '^[a-f0-9]{64}$'),
	CONSTRAINT "request_state" CHECK (("idempotency_records"."state" = 'processing' AND "idempotency_records"."response" IS NULL) OR ("idempotency_records"."state" = 'completed' AND "idempotency_records"."response" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash"),
	CONSTRAINT "session_hash" CHECK ("sessions"."token_hash" ~ '^[a-f0-9]{64}$')
);
--> statement-breakpoint
CREATE TABLE "task_activities" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"task_id" uuid NOT NULL,
	"type" text NOT NULL,
	"occurred_at" timestamp with time zone DEFAULT now() NOT NULL,
	"invalidated_by" uuid,
	CONSTRAINT "activity_owner_task_unique" UNIQUE("id","owner_id","task_id"),
	CONSTRAINT "activity_type" CHECK ("task_activities"."type" IN ('completed', 'completion_undone', 'scheduled_date_changed', 'processing_changed')),
	CONSTRAINT "activity_invalidation" CHECK ("task_activities"."invalidated_by" IS NULL OR ("task_activities"."type" = 'completed' AND "task_activities"."invalidated_by" <> "task_activities"."id"))
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"scheduled_date" date,
	"due_date" date,
	"is_unprocessed" boolean DEFAULT true NOT NULL,
	"completed_at" timestamp with time zone,
	"version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "task_owner_unique" UNIQUE("id","owner_id"),
	CONSTRAINT "task_title" CHECK (char_length("tasks"."title") BETWEEN 1 AND 200 AND "tasks"."title" = normalize(btrim("tasks"."title"), NFC) AND "tasks"."title" !~ E'[\r\n]'),
	CONSTRAINT "task_version" CHECK ("tasks"."version" > 0),
	CONSTRAINT "task_completion" CHECK (("tasks"."status" = 'open' AND "tasks"."completed_at" IS NULL) OR ("tasks"."status" = 'completed' AND "tasks"."completed_at" IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"timezone" text DEFAULT 'UTC' NOT NULL,
	"settings_version" integer DEFAULT 1 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "verifications" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone NOT NULL,
	"updated_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
ALTER TABLE "identities" ADD CONSTRAINT "identities_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "idempotency_records" ADD CONSTRAINT "idempotency_records_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_task_id_owner_id_tasks_id_owner_id_fk" FOREIGN KEY ("task_id","owner_id") REFERENCES "public"."tasks"("id","owner_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "task_activities_invalidated_by_owner_id_task_id_task_activities_id_owner_id_task_id_fk" FOREIGN KEY ("invalidated_by","owner_id","task_id") REFERENCES "public"."task_activities"("id","owner_id","task_id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "identity_user_idx" ON "identities" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "request_expiry_idx" ON "idempotency_records" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "activity_task_idx" ON "task_activities" USING btree ("task_id","occurred_at");--> statement-breakpoint
CREATE INDEX "task_inbox_idx" ON "tasks" USING btree ("owner_id","is_unprocessed","created_at","id");--> statement-breakpoint
CREATE INDEX "task_date_idx" ON "tasks" USING btree ("owner_id","status","scheduled_date","id");--> statement-breakpoint
CREATE INDEX "task_completed_idx" ON "tasks" USING btree ("owner_id","completed_at","id");--> statement-breakpoint
CREATE INDEX "verification_identifier_idx" ON "verifications" USING btree ("identifier");