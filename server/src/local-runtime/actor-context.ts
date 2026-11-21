import { AsyncLocalStorage } from "node:async_hooks";
import type { ToolOperationRecorder } from "@openbot/toolkit/tool-operation";
import { LocalExecutionLeaseError } from "./store";

export type LocalActorContext = {
  actorId: string;
  role: string;
  agentId: string;
};

function operationScope() {
  let bound: ToolOperationRecorder | undefined;
  const current = () => {
    if (!bound)
      throw new LocalExecutionLeaseError(
        "No local attempt is bound to this request.",
      );
    return bound;
  };
  const recorder: ToolOperationRecorder = {
    authorize: (intent) => current().authorize(intent),
    begin: (intent) => current().begin(intent),
    dispatch: (id) => current().dispatch(id),
    track: (id) => current().track?.(id) ?? (() => {}),
    settle: (id, outcome, result) => current().settle(id, outcome, result),
  };
  return {
    recorder,
    bind(attempt: ToolOperationRecorder) {
      if (bound)
        throw new Error("Local request is already bound to an attempt.");
      bound = attempt;
    },
  };
}

type LocalRequestContext = LocalActorContext & {
  operations: ReturnType<typeof operationScope>;
};
const actorContext = new AsyncLocalStorage<LocalRequestContext>();

export function withLocalActorContext<T>(
  context: LocalActorContext,
  operation: () => T,
): T {
  return actorContext.run(
    { ...context, operations: operationScope() },
    operation,
  );
}

export function currentLocalActorContext(): LocalRequestContext | undefined {
  return actorContext.getStore();
}
