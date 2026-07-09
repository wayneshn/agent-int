CREATE TYPE "public"."agent_mission_status" AS ENUM('draft', 'active', 'paused', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."mission_schedule_mode" AS ENUM('agent', 'fixed');--> statement-breakpoint
ALTER TYPE "public"."agent_trigger_type" ADD VALUE 'mission';--> statement-breakpoint
CREATE TABLE "agent_mission_approvals" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"action" text NOT NULL,
	"rationale" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"decision_note" text,
	"decided_at" timestamp,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_mission_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"mission_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"data" jsonb,
	"thread_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "agent_missions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"agent_id" uuid NOT NULL,
	"owner_id" uuid NOT NULL,
	"title" varchar(255) NOT NULL,
	"goal" text NOT NULL,
	"status" "agent_mission_status" DEFAULT 'draft' NOT NULL,
	"status_reason" text,
	"plan_document" text,
	"schedule_mode" "mission_schedule_mode" DEFAULT 'agent' NOT NULL,
	"cron_expr" text,
	"timezone" text,
	"min_interval_minutes" integer DEFAULT 30 NOT NULL,
	"max_interval_minutes" integer DEFAULT 1440 NOT NULL,
	"next_wake_at" timestamp,
	"last_wake_at" timestamp,
	"consecutive_failures" integer DEFAULT 0 NOT NULL,
	"max_cost_total" numeric(12, 6) NOT NULL,
	"max_cost_per_day" numeric(12, 6),
	"max_turns_per_day" integer,
	"cost_total" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cost_today" numeric(12, 6) DEFAULT '0' NOT NULL,
	"cost_today_date" text,
	"turns_today" integer DEFAULT 0 NOT NULL,
	"total_turns" integer DEFAULT 0 NOT NULL,
	"current_thread_id" uuid,
	"approval_policy" text DEFAULT 'risky' NOT NULL,
	"report_channel_link_id" uuid,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"agent_id" uuid,
	"mission_id" uuid,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"body" text,
	"link_path" text,
	"is_read" boolean DEFAULT false NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "mission_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_mission_approvals" ADD CONSTRAINT "agent_mission_approvals_mission_id_agent_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."agent_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mission_events" ADD CONSTRAINT "agent_mission_events_mission_id_agent_missions_id_fk" FOREIGN KEY ("mission_id") REFERENCES "public"."agent_missions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_current_thread_id_agent_threads_id_fk" FOREIGN KEY ("current_thread_id") REFERENCES "public"."agent_threads"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_missions" ADD CONSTRAINT "agent_missions_report_channel_link_id_channel_links_id_fk" FOREIGN KEY ("report_channel_link_id") REFERENCES "public"."channel_links"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_mission_approvals_mission_status_idx" ON "agent_mission_approvals" USING btree ("mission_id","status");--> statement-breakpoint
CREATE INDEX "agent_mission_events_mission_created_idx" ON "agent_mission_events" USING btree ("mission_id","created_at");--> statement-breakpoint
CREATE INDEX "agent_missions_agent_id_idx" ON "agent_missions" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_missions_owner_id_idx" ON "agent_missions" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agent_missions_status_next_wake_idx" ON "agent_missions" USING btree ("status","next_wake_at");--> statement-breakpoint
CREATE INDEX "notifications_user_read_created_idx" ON "notifications" USING btree ("user_id","is_read","created_at");--> statement-breakpoint
CREATE INDEX "agent_threads_mission_id_idx" ON "agent_threads" USING btree ("mission_id");