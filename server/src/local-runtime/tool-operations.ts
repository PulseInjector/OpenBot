import type { ToolOperationRecorder } from "@openbot/toolkit/tool-operation";
import type { createLocalRuntimeStore, ExecutionToken } from "./store";

type OperationStore = Pick<
  ReturnType<typeof createLocalRuntimeStore>,
  | "beginOperation"
  | "markOperationDispatched"
  | "settleOperation"
  | "requestStop"
>;

/** Binds the shared tool boundary to one trusted actor and current attempt. */
export function localToolOperationRecorder(input: {
  store: OperationStore;
  token: ExecutionToken;
  actorId: string;
  authorize: (intent: {
    toolCallId: string;
    toolName: string;
    parameters: Record<string, unknown>;
  }) => Promise<void>;
}): ToolOperationRecorder & { drain: () => Promise<void> } {
  const operationIds = new Set<string>();
  const inFlight = new Set<Promise<void>>();
  const drain = async () => {
    await Promise.all(inFlight);
  };
  return {
    authorize: input.authorize,
    async begin(intent) {
      const { operation } = await input.store.beginOperation(input.token, {
        ...intent,
        actorId: input.actorId,
      });
      operationIds.add(operation.id);
      return operation.id;
    },
    async dispatch(operationId) {
      if (!operationIds.has(operationId))
        throw new Error("Unknown operation id.");
      await input.store.markOperationDispatched(input.token, operationId);
    },
    track(operationId) {
      if (!operationIds.has(operationId))
        throw new Error("Unknown operation id.");
      const settled = Promise.withResolvers<void>();
      inFlight.add(settled.promise);
      return () => {
        inFlight.delete(settled.promise);
        settled.resolve();
      };
    },
    async stop(reason = "user") {
      await input.store.requestStop(input.token, reason);
      await drain();
    },
    drain,
    async settle(operationId, outcome, result) {
      if (!operationIds.has(operationId))
        throw new Error("Unknown operation id.");
      await input.store.settleOperation(
        input.token,
        operationId,
        outcome,
        result,
      );
    },
  };
}
