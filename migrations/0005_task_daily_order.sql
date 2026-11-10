ALTER TABLE "task_activities" DROP CONSTRAINT "activity_type";--> statement-breakpoint
ALTER TABLE "tasks" ADD COLUMN "daily_order" integer;--> statement-breakpoint
WITH ranked AS (
  SELECT id, row_number() OVER (PARTITION BY owner_id, scheduled_date ORDER BY created_at, id)::integer AS daily_order
  FROM tasks WHERE scheduled_date IS NOT NULL
)
UPDATE tasks SET daily_order = ranked.daily_order FROM ranked WHERE tasks.id = ranked.id;
--> statement-breakpoint
CREATE INDEX "task_day_order_idx" ON "tasks" USING btree ("owner_id","scheduled_date","daily_order","created_at","id");--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "activity_type" CHECK ("task_activities"."type" IN ('completed', 'completion_undone', 'scheduled_date_changed', 'processing_changed', 'deferred', 'canceled', 'reopened', 'priority_changed', 'kind_changed', 'order_changed'));--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "task_daily_order" CHECK (("tasks"."scheduled_date" IS NULL AND "tasks"."daily_order" IS NULL) OR ("tasks"."scheduled_date" IS NOT NULL AND "tasks"."daily_order" IS NOT NULL AND "tasks"."daily_order" > 0));
