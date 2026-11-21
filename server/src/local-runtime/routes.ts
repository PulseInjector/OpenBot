import { Hono, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppVariables } from "../auth/guards";
import type { createLocalRuntimeStore } from "./store";
import { summarizeRunState } from "./summary";

type LocalRuntimeStore = ReturnType<typeof createLocalRuntimeStore>;
type LocalHistory = Awaited<ReturnType<LocalRuntimeStore["readHistory"]>>;
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
      const binding = await input.store.readBinding({
        threadId,
        actorId: actor.id,
      });
      if (!(await input.canUseBot(actor, binding.agentId))) {
        return context.json({ error: "Local thread was not found." }, 404);
      }
      return context.json(
        await input.store.readHistory({
          threadId,
          actorId: actor.id,
          agentId: binding.agentId,
        }),
      );
    } catch {
      return context.json({ error: "Local thread was not found." }, 404);
    }
  });

  routes.get("/threads/:threadId/status", async (context) => {
    const threadId = context.req.param("threadId");
    const actor = context.var.actor;
    let history: LocalHistory;
    try {
      const binding = await input.store.readBinding({
        threadId,
        actorId: actor.id,
      });
      if (!(await input.canUseBot(actor, binding.agentId))) {
        return context.json({ error: "Local thread was not found." }, 404);
      }
      history = await input.store.readHistory({
        threadId,
        actorId: actor.id,
        agentId: binding.agentId,
      });
    } catch {
      return context.json({ error: "Local thread was not found." }, 404);
    }
    // Outside the catch on purpose: a stored pair that disagrees is a defect, and it must surface
    // as the app's own 500 rather than borrow the not-found answer the boundary failures own.
    return context.json({ status: summarizeRunState(history) });
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
      const binding = await input.store.readBinding({
        threadId: context.req.param("threadId"),
        actorId: actor.id,
      });
      if (!(await input.canUseBot(actor, binding.agentId))) {
        return context.json({ error: "Local thread was not found." }, 404);
      }
      const events = await input.store.readEventsAfter({
        threadId: context.req.param("threadId"),
        actorId: actor.id,
        agentId: binding.agentId,
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
