ALTER TABLE "task_activities" ADD COLUMN "details" jsonb;
--> statement-breakpoint
CREATE FUNCTION public.planner_valid_plan_snapshot(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE field text; date_value text; order_value numeric;
BEGIN
  IF value IS NULL OR jsonb_typeof(value) <> 'object' OR NOT value ?& ARRAY['scheduledDate','dueDate','status','dailyOrder']
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 4 THEN RETURN false; END IF;
  IF jsonb_typeof(value->'status') <> 'string' OR value->>'status' NOT IN ('open','completed','deferred','canceled') THEN RETURN false; END IF;
  FOREACH field IN ARRAY ARRAY['scheduledDate','dueDate'] LOOP
    IF value->field <> 'null'::jsonb THEN
      IF jsonb_typeof(value->field) <> 'string' THEN RETURN false; END IF;
      date_value := value->>field;
      IF date_value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' OR date_value::date NOT BETWEEN DATE '0001-01-01' AND DATE '9999-12-31'
        OR to_char(date_value::date,'YYYY-MM-DD') <> date_value THEN RETURN false; END IF;
    END IF;
  END LOOP;
  IF value->'scheduledDate' = 'null'::jsonb THEN RETURN value->'dailyOrder' = 'null'::jsonb; END IF;
  IF jsonb_typeof(value->'dailyOrder') <> 'number' THEN RETURN false; END IF;
  order_value := (value->>'dailyOrder')::numeric;
  RETURN order_value BETWEEN 1 AND 2147483647 AND trunc(order_value) = order_value;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
CREATE FUNCTION public.planner_valid_activity_details(value jsonb, event_type text) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE AS $$
DECLARE version_value numeric;
BEGIN
  -- Existing activities deliberately keep unknown historical values as SQL NULL.
  IF value IS NULL THEN RETURN event_type NOT IN ('created','due_date_changed'); END IF;
  IF jsonb_typeof(value) <> 'object' OR NOT value ?& ARRAY['before','after','version']
    OR (SELECT count(*) FROM jsonb_object_keys(value)) <> 3 OR jsonb_typeof(value->'version') <> 'number' THEN RETURN false; END IF;
  version_value := (value->>'version')::numeric;
  IF version_value NOT BETWEEN 1 AND 2147483647 OR trunc(version_value) <> version_value OR NOT public.planner_valid_plan_snapshot(value->'after') THEN RETURN false; END IF;
  IF event_type = 'created' THEN RETURN value->'before' = 'null'::jsonb AND version_value = 1; END IF;
  RETURN version_value > 1 AND public.planner_valid_plan_snapshot(value->'before');
EXCEPTION WHEN OTHERS THEN RETURN false;
END $$;
--> statement-breakpoint
ALTER TABLE "task_activities" DROP CONSTRAINT "activity_type";
--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "activity_type" CHECK ("type" IN ('created','due_date_changed','completed','completion_undone','scheduled_date_changed','processing_changed','deferred','canceled','reopened','priority_changed','kind_changed','order_changed'));
--> statement-breakpoint
ALTER TABLE "task_activities" ADD CONSTRAINT "activity_details" CHECK (public.planner_valid_activity_details("details", "type"));
--> statement-breakpoint
CREATE INDEX "task_due_idx" ON "tasks" USING btree ("owner_id","due_date","created_at","id");
--> statement-breakpoint
CREATE INDEX "activity_history_idx" ON "task_activities" USING btree ("owner_id","task_id","occurred_at","id");
