CREATE TABLE "local_attempts" (
	"id" text PRIMARY KEY NOT NULL,
	"run_id" text NOT NULL,
	"thread_id" text NOT NULL,
	"generation" bigint NOT NULL,
	"owner" text NOT NULL,
	"lease_until" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'running' NOT NULL,
	"end_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "local_events" (
	"thread_id" text NOT NULL,
	"sequence" bigint NOT NULL,
	"id" text NOT NULL,
	"run_id" text,
	"attempt_id" text,
	"type" text NOT NULL,
	"message_id" text,
	"payload" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_events_thread_id_sequence_pk" PRIMARY KEY("thread_id","sequence"),
	CONSTRAINT "local_events_id_unique" UNIQUE("id")
);
--> statement-breakpoint
CREATE TABLE "local_messages" (
	"thread_id" text NOT NULL,
	"message_id" text NOT NULL,
	"role" text NOT NULL,
	"content" jsonb NOT NULL,
	"last_sequence" bigint NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "local_messages_thread_id_message_id_pk" PRIMARY KEY("thread_id","message_id")
);
--> statement-breakpoint
CREATE TABLE "local_operations" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"run_id" text NOT NULL,
	"attempt_id" text NOT NULL,
	"tool_call_id" text NOT NULL,
	"tool_name" text NOT NULL,
	"target" text,
	"parameters" jsonb NOT NULL,
	"actor_id" text NOT NULL,
	"dispatched" boolean DEFAULT false NOT NULL,
	"status" text DEFAULT 'intent' NOT NULL,
	"result" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"dispatched_at" timestamp with time zone,
	"settled_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "local_runs" (
	"id" text PRIMARY KEY NOT NULL,
	"thread_id" text NOT NULL,
	"actor_id" text NOT NULL,
	"source" text NOT NULL,
	"request_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"business_ref" text,
	"status" text DEFAULT 'queued' NOT NULL,
	"result_ref" text,
	"error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "local_thread_bindings" (
	"thread_id" text PRIMARY KEY NOT NULL,
	"owner_user_id" text NOT NULL,
	"agent_id" text NOT NULL,
	"history_version" integer DEFAULT 1 NOT NULL,
	"next_event_sequence" bigint DEFAULT 1 NOT NULL,
	"execution_generation" bigint DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "local_attempts" ADD CONSTRAINT "local_attempts_run_id_local_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."local_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_attempts" ADD CONSTRAINT "local_attempts_thread_id_local_thread_bindings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."local_thread_bindings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_events" ADD CONSTRAINT "local_events_thread_id_local_thread_bindings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."local_thread_bindings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_events" ADD CONSTRAINT "local_events_run_id_local_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."local_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_events" ADD CONSTRAINT "local_events_attempt_id_local_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."local_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_messages" ADD CONSTRAINT "local_messages_thread_id_local_thread_bindings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."local_thread_bindings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_thread_id_local_thread_bindings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."local_thread_bindings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_run_id_local_runs_id_fk" FOREIGN KEY ("run_id") REFERENCES "public"."local_runs"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_attempt_id_local_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."local_attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_operations" ADD CONSTRAINT "local_operations_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_runs" ADD CONSTRAINT "local_runs_thread_id_local_thread_bindings_thread_id_fk" FOREIGN KEY ("thread_id") REFERENCES "public"."local_thread_bindings"("thread_id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_runs" ADD CONSTRAINT "local_runs_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_thread_bindings" ADD CONSTRAINT "local_thread_bindings_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "local_thread_bindings" ADD CONSTRAINT "local_thread_bindings_agent_id_agents_id_fk" FOREIGN KEY ("agent_id") REFERENCES "public"."agents"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "local_attempts_thread_generation_idx" ON "local_attempts" USING btree ("thread_id","generation");--> statement-breakpoint
CREATE INDEX "local_attempts_run_created_idx" ON "local_attempts" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE INDEX "local_attempts_expired_idx" ON "local_attempts" USING btree ("lease_until") WHERE "local_attempts"."status" = 'running';--> statement-breakpoint
CREATE UNIQUE INDEX "local_operations_attempt_tool_call_idx" ON "local_operations" USING btree ("attempt_id","tool_call_id");--> statement-breakpoint
CREATE INDEX "local_operations_run_created_idx" ON "local_operations" USING btree ("run_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "local_runs_thread_request_key_idx" ON "local_runs" USING btree ("thread_id","request_key");--> statement-breakpoint
CREATE INDEX "local_runs_thread_created_idx" ON "local_runs" USING btree ("thread_id","created_at");
