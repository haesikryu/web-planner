ALTER TABLE "task_activities" DROP CONSTRAINT "activity_type";--> statement-breakpoint
ALTER TABLE "tasks" DROP CONSTRAINT "task_completion";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "priority" text DEFAULT 'medium' NOT NULL;--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "kind" text DEFAULT 'task' NOT NULL;--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "activity_type" CHECK ("task_activities"."type" IN ('completed', 'completion_undone', 'scheduled_date_changed', 'processing_changed', 'deferred', 'canceled', 'reopened', 'priority_changed', 'kind_changed'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_priority" CHECK ("tasks"."priority" IN ('high', 'medium', 'low'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_kind" CHECK ("tasks"."kind" IN ('task', 'appointment', 'event'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_completion" CHECK (("tasks"."status" IN ('open', 'deferred', 'canceled') AND "tasks"."completed_at" IS NULL) OR ("tasks"."status" = 'completed' AND "tasks"."completed_at" IS NOT NULL));