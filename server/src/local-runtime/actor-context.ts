import { AsyncLocalStorage } from "node:async_hooks";

export type LocalActorContext = {
  actorId: string;
  role: string;
  agentId: string;
};

const actorContext = new AsyncLocalStorage<LocalActorContext>();

export function withLocalActorContext<T>(
  context: LocalActorContext,
  operation: () => T,
): T {
  return actorContext.run(context, operation);
}

export function currentLocalActorContext(): LocalActorContext | undefined {
  return actorContext.getStore();
}
