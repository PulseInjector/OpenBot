import { AsyncLocalStorage } from "node:async_hooks";
import type { Message, RunAgentInput } from "@ag-ui/client";
import type { AuditInitiator } from "./initiator";

/**
 * Everything needed to pick a turn up again at the tool call it stopped on, once a person has
 * answered. Re-exported from approvals/types.ts, which parses and stores it.
 */
export type ApprovalContinuation = {
  runId: string;
  threadId: string;
  toolCallId: string;
  toolName: string;
  args: unknown;
  messages: Message[];
  state: unknown;
  context: RunAgentInput["context"];
  forwardedProps: unknown;
  initiator?: AuditInitiator;
};

const actionContext = new AsyncLocalStorage<ApprovalContinuation>();

/** Run a tool call with its continuation in scope, so a refusal inside it can be resumed later. */
export const withApprovalContext = <T>(
  context: ApprovalContinuation,
  run: () => Promise<T>,
): Promise<T> => actionContext.run(context, run);

export const currentApprovalContext = () => actionContext.getStore();

/*
 * The tool call id of the recorded execute in scope. Narrower than the approval context on
 * purpose: the channel path (copilot's built-in agent) records every tool through
 * `executeRecordedTool` with no approval continuation to enter, because a continuation there
 * would claim a resume that path cannot honor. The connector trace still needs the id to join
 * a physical call to its recorded operation, so the recorder wrapper carries just the id.
 */
const toolCallIdContext = new AsyncLocalStorage<string>();

/** Run a callback with a tool call id in scope, for the connector trace to cite. */
export const withToolCallId = <T>(
  toolCallId: string,
  run: () => Promise<T>,
): Promise<T> => toolCallIdContext.run(toolCallId, run);

export const currentToolCallId = () => toolCallIdContext.getStore();
