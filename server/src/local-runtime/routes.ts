import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { createLocalRuntimeStore } from "./store";

type LocalRuntimeStore = ReturnType<typeof createLocalRuntimeStore>;
type RequireUser = MiddlewareHandler<{ Variables: AppVariables }>;

export function createLocalRuntimeRoutes(input: {
  store: LocalRuntimeStore;
  requireUser: RequireUser;
  canUseBot: (
    actor: AppVariables["actor"],
    agentId: string,
  ) => Promise<boolean>;
}) {
  const routes = new Hono<{ Variables: AppVariables }>();
  routes.use("*", input.requireUser);

  routes.get("/threads/:threadId/history", async (context) => {
    const threadId = context.req.param("threadId");
    const actor = context.var.actor;
    try {
      const history = await input.store.readHistory({
        threadId,
        actorId: actor.id,
      });
      if (!(await input.canUseBot(actor, history.binding.agentId))) {
        return context.json({ error: "Local thread was not found." }, 404);
      }
      return context.json(history);
    } catch {
      return context.json({ error: "Local thread was not found." }, 404);
    }
  });

  routes.get("/threads/:threadId/events", async (context) => {
    const query = z
      .object({
        after: z.coerce.number().int().nonnegative().default(0),
        limit: z.coerce.number().int().min(1).max(500).default(100),
      })
      .safeParse(context.req.query());
    if (!query.success) {
      return context.json({ error: "Invalid event cursor." }, 400);
    }
    const actor = context.var.actor;
    try {
      const history = await input.store.readHistory({
        threadId: context.req.param("threadId"),
        actorId: actor.id,
      });
      if (!(await input.canUseBot(actor, history.binding.agentId))) {
        return context.json({ error: "Local thread was not found." }, 404);
      }
      const events = await input.store.readEventsAfter({
        threadId: context.req.param("threadId"),
        actorId: actor.id,
        agentId: history.binding.agentId,
        afterSequence: query.data.after,
        limit: query.data.limit,
      });
      return context.json({ events });
    } catch {
      return context.json({ error: "Local thread was not found." }, 404);
    }
  });

  return routes;
}
