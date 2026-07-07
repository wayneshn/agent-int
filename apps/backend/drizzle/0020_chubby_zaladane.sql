ALTER TYPE "public"."agent_trigger_type" ADD VALUE 'agent';--> statement-breakpoint
CREATE TABLE "agent_collaborators" (
	"agent_id" uuid NOT NULL,
	"target_agent_id" uuid NOT NULL,
	CONSTRAINT "agent_collaborators_agent_id_target_agent_id_pk" PRIMARY KEY("agent_id","target_agent_id")
);
--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "initiator_agent_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "parent_thread_id" uuid;--> statement-breakpoint
ALTER TABLE "agent_threads" ADD COLUMN "delegation_chain" jsonb;--> statement-breakpoint
ALTER TABLE "agent_collaborators" ADD CONSTRAINT "agent_collaborators_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_collaborators" ADD CONSTRAINT "agent_collaborators_target_agent_id_agents_id_fk" FOREIGN KEY ("target_agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_collaborators_agent_id_idx" ON "agent_collaborators" USING btree ("agent_id");--> statement-breakpoint
CREATE INDEX "agent_threads_initiator_agent_id_idx" ON "agent_threads" USING btree ("initiator_agent_id");