CREATE TABLE "mcp_servers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"name" varchar(255) NOT NULL,
	"slug" varchar(128) NOT NULL,
	"transport" varchar(16) NOT NULL,
	"url" text,
	"auth_type" varchar(16) DEFAULT 'none' NOT NULL,
	"data" text NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"status" varchar(16) DEFAULT 'unknown' NOT NULL,
	"last_error" text,
	"tools_cache" jsonb,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL,
	CONSTRAINT "mcp_servers_owner_slug_uq" UNIQUE("owner_id","slug")
);
--> statement-breakpoint
CREATE TABLE "agent_mcp_servers" (
	"agent_id" uuid NOT NULL,
	"mcp_server_id" uuid NOT NULL,
	"enabled_tools" jsonb,
	CONSTRAINT "agent_mcp_servers_agent_id_mcp_server_id_pk" PRIMARY KEY("agent_id","mcp_server_id")
);
--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "agent_mcp_servers" ADD CONSTRAINT "agent_mcp_servers_mcp_server_id_mcp_servers_id_fk" FOREIGN KEY ("mcp_server_id") REFERENCES "public"."mcp_servers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "mcp_servers_owner_id_idx" ON "mcp_servers" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX "agent_mcp_servers_agent_id_idx" ON "agent_mcp_servers" USING btree ("agent_id");