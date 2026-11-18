import type { ToolOperationRecorder } from "@openbot/toolkit/tool-operation";
import type { createLocalRuntimeStore, ExecutionToken } from "./store";

type OperationStore = Pick<
  ReturnType<typeof createLocalRuntimeStore>,
  "beginOperation" | "markOperationDispatched" | "settleOperation"
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
}): ToolOperationRecorder {
  const operationIds = new Set<string>();
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
