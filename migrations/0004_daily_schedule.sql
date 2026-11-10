CREATE FUNCTION public.planner_valid_schedule_slots(value jsonb) RETURNS boolean
LANGUAGE plpgsql IMMUTABLE STRICT AS $$
DECLARE
  slot jsonb;
  minute numeric;
  previous_minute integer := 330;
  slot_title text;
BEGIN
  IF jsonb_typeof(value) <> 'array' THEN RETURN false; END IF;
  IF jsonb_array_length(value) > 36 THEN RETURN false; END IF;
  FOR slot IN SELECT * FROM jsonb_array_elements(value) LOOP
    IF jsonb_typeof(slot) <> 'object' THEN RETURN false; END IF;
    IF jsonb_typeof(slot->'startMinute') IS DISTINCT FROM 'number'
      OR jsonb_typeof(slot->'title') IS DISTINCT FROM 'string' THEN RETURN false; END IF;
    IF (SELECT count(*) FROM jsonb_object_keys(slot)) <> 2 THEN RETURN false; END IF;
    minute := (slot->>'startMinute')::numeric;
    IF minute < 360 OR minute > 1410 OR mod(minute, 30) <> 0 OR minute <= previous_minute THEN RETURN false; END IF;
    slot_title := slot->>'title';
    IF char_length(slot_title) NOT BETWEEN 1 AND 200
      OR slot_title <> normalize(btrim(slot_title), NFC)
      OR slot_title ~ E'[\r\n]' THEN RETURN false; END IF;
    previous_minute := minute::integer;
  END LOOP;
  RETURN true;
END;
$$;
--> statement-breakpoint
CREATE TABLE "schedule_entries" (
	"owner_id" text NOT NULL,
	"entry_date" date NOT NULL,
	"slots" jsonb NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "schedule_entries_owner_id_entry_date_pk" PRIMARY KEY("owner_id","entry_date"),
	CONSTRAINT "schedule_slots" CHECK (public.planner_valid_schedule_slots("schedule_entries"."slots")),
	CONSTRAINT "schedule_version" CHECK ("schedule_entries"."version" > 0),
	CONSTRAINT "schedule_date" CHECK ("schedule_entries"."entry_date" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
--> statement-breakpoint
ALTER TABLE "schedule_entries" ADD CONSTRAINT "schedule_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
