CREATE TABLE "agent_creation_requests" (
	"actor_id" text NOT NULL,
	"request_id" text NOT NULL,
	"request_hash" text NOT NULL,
	"agent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "agent_creation_requests_actor_id_request_id_pk" PRIMARY KEY("actor_id","request_id")
);
--> statement-breakpoint
ALTER TABLE "agent_creation_requests" ADD CONSTRAINT "agent_creation_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "agent_creation_requests_agent_idx" ON "agent_creation_requests" USING btree ("agent_id");