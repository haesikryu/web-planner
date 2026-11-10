CREATE TABLE "journal_entries" (
	"owner_id" text NOT NULL,
	"entry_date" date NOT NULL,
	"content" text NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "journal_entries_owner_id_entry_date_pk" PRIMARY KEY("owner_id","entry_date"),
	CONSTRAINT "journal_content" CHECK (char_length("journal_entries"."content") <= 10000 AND "journal_entries"."content" !~ E'\r\n'),
	CONSTRAINT "journal_version" CHECK ("journal_entries"."version" > 0),
	CONSTRAINT "journal_date" CHECK ("journal_entries"."entry_date" BETWEEN DATE '0001-01-01' AND DATE '9999-12-31')
);
--> statement-breakpoint
ALTER TABLE "journal_entries" ADD CONSTRAINT "journal_entries_owner_id_users_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;