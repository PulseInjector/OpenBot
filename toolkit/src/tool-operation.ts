import { withToolCallId } from "./continuation";

export type ToolOperationIntent = {
  toolCallId: string;
  toolName: string;
  parameters: Record<string, unknown>;
};

export type ToolOperationRecorder = {
  authorize(intent: ToolOperationIntent): Promise<void>;
  begin(intent: ToolOperationIntent): Promise<string>;
  dispatch(operationId: string): Promise<void>;
  settle(
    operationId: string,
    outcome: "succeeded" | "failed" | "unknown",
    result: Record<string, unknown>,
  ): Promise<void>;
  track?(operationId: string): () => void;
  stop?(reason?: string): Promise<void>;
};

function completeObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be a complete JSON object.");
  }
  return Object.fromEntries(Object.entries(value));
}

/** Records the complete call before dispatch and settles it before returning to the model. */
export async function executeRecordedTool<T>(input: {
  recorder?: ToolOperationRecorder;
  toolCallId?: string;
  toolName: string;
  parameters: unknown;
  validate?: (parameters: unknown) => unknown;
  execute: (parameters: Record<string, unknown>) => Promise<T>;
  disconnected?: () => boolean;
  settlementTimeoutMs?: number;
}): Promise<T> {
  const parameters = completeObject(
    input.validate ? input.validate(input.parameters) : input.parameters,
  );
  const recorder = input.recorder;
  // The id travels with the execute itself, so the connector trace at the vendor boundary can
  // cite it even on paths that hold no approval continuation (the channel path, whose live runs
  // proved the id otherwise never reaches the trace line).
  const executeInScope = () =>
    input.toolCallId === undefined
      ? input.execute(parameters)
      : withToolCallId(input.toolCallId, () => input.execute(parameters));
  if (!recorder) return executeInScope();
  if (!input.toolCallId)
    throw new Error("Tool call id is required for recording.");
  const intent = {
    toolCallId: input.toolCallId,
    toolName: input.toolName,
    parameters,
  };
  await recorder.authorize(intent);
  const operationId = await recorder.begin(intent);
  await recorder.authorize(intent);
  const release = recorder.track?.(operationId);
  try {
    await recorder.dispatch(operationId);
    return await executeDispatched({
      executeInScope,
      recorder,
      operationId,
      disconnected: input.disconnected,
      settlementTimeoutMs: input.settlementTimeoutMs,
    });
  } finally {
    release?.();
  }
}

async function executeDispatched<T>(input: {
  executeInScope: () => Promise<T>;
  recorder: ToolOperationRecorder;
  operationId: string;
  disconnected?: () => boolean;
  settlementTimeoutMs?: number;
}): Promise<T> {
  const timeoutMs = input.settlementTimeoutMs ?? 30_000;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const execution = Promise.resolve().then(() => input.executeInScope());
  try {
    const result = await Promise.race([
      execution,
      new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new Error("Tool settlement timed out.")),
          timeoutMs,
        );
      }),
    ]);
    if (timer) clearTimeout(timer);
    const serialized = JSON.stringify(result);
    await input.recorder.settle(input.operationId, "succeeded", {
      value: serialized === undefined ? null : JSON.parse(serialized),
    });
    return result;
  } catch (error) {
    if (timer) clearTimeout(timer);
    const timedOut =
      error instanceof Error && error.message === "Tool settlement timed out.";
    await input.recorder.settle(input.operationId, "unknown", {
      reason: timedOut
        ? "Tool did not settle before the operation deadline."
        : input.disconnected?.()
          ? "Tool result arrived after the run disconnected."
          : "Dispatched tool ended without a verifiable result.",
      error: error instanceof Error ? error.message : String(error),
    });
    if (timedOut) {
      void execution.then(
        async (lateResult) => {
          try {
            const lateJson = JSON.stringify(lateResult);
            await input.recorder.settle(input.operationId, "succeeded", {
              value: lateJson === undefined ? null : JSON.parse(lateJson),
              late: true,
            });
          } catch (lateError) {
            await input.recorder
              .settle(input.operationId, "unknown", {
                reason: "Late result could not be durably verified.",
                error:
                  lateError instanceof Error
                    ? lateError.message
                    : String(lateError),
              })
              .catch(() => undefined);
          }
        },
        async (lateError: unknown) => {
          await input.recorder
            .settle(input.operationId, "unknown", {
              reason: "Dispatched tool failed after the settlement deadline.",
              error:
                lateError instanceof Error
                  ? lateError.message
                  : String(lateError),
              late: true,
            })
            .catch(() => undefined);
        },
      );
    }
    throw error;
  }
}
