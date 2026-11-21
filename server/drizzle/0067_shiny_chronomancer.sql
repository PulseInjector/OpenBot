CREATE TABLE "owner_app_grant_requests" (
	"actor_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"app_key" text NOT NULL,
	"request_id" text NOT NULL,
	"refs" text[] NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "owner_app_grant_requests_actor_id_agent_id_app_key_request_id_pk" PRIMARY KEY("actor_id","agent_id","app_key","request_id")
);
--> statement-breakpoint
ALTER TABLE "owner_app_grant_requests" ADD CONSTRAINT "owner_app_grant_requests_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "owner_app_grant_requests" ADD CONSTRAINT "owner_app_grant_requests_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;