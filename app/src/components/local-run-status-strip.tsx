import { useLocalRunStatus } from "@/lib/copilot/local-run-status";
import { cn } from "@/lib/utils";

/**
 * One line above a conversation's composer saying what its last run is doing.
 *
 * The phase comes from the server's own derivation, so this strip never turns a stored run into a
 * second opinion. `className` carries a surface's layout only: the tone belongs to the phase, so a
 * failure reads as one in the channel's notice stack and in the `/bot` page's banners alike.
 */
export function LocalRunStatusStrip({
  threadId,
  agentId,
  className,
}: {
  threadId: string;
  agentId: string;
  className?: string;
}) {
  const status = useLocalRunStatus(threadId, agentId);

  switch (status.phase) {
    case "idle":
    case "unavailable":
      /*
       * Nothing to say. `unavailable` deliberately draws no line: the transcript's own history
       * notice already reports a store this app cannot read, and a second sentence here would
       * repeat it without adding the phase.
       */
      return null;
    case "queued":
    case "running":
      return (
        <p
          className={cn("text-sm text-muted-foreground", className)}
          role="status"
        >
          Run is active
        </p>
      );
    case "succeeded":
      return (
        <p
          className={cn("text-sm text-muted-foreground", className)}
          role="status"
        >
          Run succeeded
        </p>
      );
    case "failed":
      return (
        <p className={cn("text-sm text-destructive", className)} role="alert">
          Run failed: {status.reason}
        </p>
      );
    case "interrupted":
      return (
        <p className={cn("text-sm text-destructive", className)} role="alert">
          Run was interrupted: {status.reason}
        </p>
      );
  }
}
