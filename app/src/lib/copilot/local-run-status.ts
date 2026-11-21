import { useEffect, useState } from "react";
import { z } from "zod";
import { tryClient } from "@/lib/client";
import { runtimeMode } from "./runtime-mode";

/** One second is the design's poll cadence while a run is live (`unit-6-reconnect-and-desktop.md`). */
const POLL_INTERVAL_MS = 1000;

/**
 * The status route answers `{ status: summarizeRunState(history) }`, so this schema is the wire's
 * own union, not a second set of phase rules. An unknown phase fails here rather than reaching the
 * strip as a guess.
 */
const localRunStatusSchema = z.discriminatedUnion("phase", [
  z.object({ phase: z.literal("idle") }),
  z.object({ phase: z.literal("queued"), runId: z.string() }),
  z.object({ phase: z.literal("running"), runId: z.string() }),
  z.object({ phase: z.literal("succeeded"), runId: z.string() }),
  z.object({
    phase: z.literal("failed"),
    runId: z.string(),
    reason: z.string(),
  }),
  z.object({
    phase: z.literal("interrupted"),
    runId: z.string(),
    reason: z.string(),
  }),
]);

const statusEnvelopeSchema = z.object({ status: localRunStatusSchema });

export type LocalRunStatus = z.infer<typeof localRunStatusSchema>;

/**
 * A read that could not be trusted. Not `idle`: idle is the server saying no run exists, while
 * `unavailable` is this app saying it does not know. Only the latter means the request failed or
 * the body did not match the schema.
 */
export type LocalRunStatusState = LocalRunStatus | { phase: "unavailable" };

async function readRunStatus(
  threadId: string,
  signal: AbortSignal,
): Promise<LocalRunStatusState> {
  try {
    const response = await tryClient(
      `/api/local-runtime/threads/${encodeURIComponent(threadId)}/status`,
      { signal },
    );
    if (!response.ok) return { phase: "unavailable" };
    const body: unknown = await response.json();
    const parsed = statusEnvelopeSchema.safeParse(body);
    return parsed.success ? parsed.data.status : { phase: "unavailable" };
  } catch {
    return { phase: "unavailable" };
  }
}

/**
 * Follow one thread's run status by polling the server's derivation.
 *
 * The server owns what a run's phase is (`summarizeRunState`), and this hook only reads it. A poll
 * exists because a reload or a lost stream has no live run to observe, and the status route
 * survives both. Terminal and idle phases are read once and never polled.
 */
export function useLocalRunStatus(
  threadId: string,
  agentId: string,
): LocalRunStatusState {
  const [status, setStatus] = useState<LocalRunStatusState>({ phase: "idle" });

  // biome-ignore lint/correctness/useExhaustiveDependencies: `agentId` restarts the read when a surface switches Bots; the status route itself is thread-scoped.
  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    // A new thread must not keep showing the previous thread's line while its own read is in flight.
    setStatus((current) =>
      current.phase === "idle" ? current : { phase: "idle" },
    );

    const poll = async () => {
      const next = await readRunStatus(threadId, controller.signal);
      if (cancelled) return;
      setStatus(next);
      if (next.phase === "queued" || next.phase === "running") {
        timer = setTimeout(() => void poll(), POLL_INTERVAL_MS);
      }
    };

    void (async () => {
      /*
       * No signal on purpose: `runtimeMode` caches one probe per transport, and aborting a probe
       * another surface may also be waiting on would make that one read look like a failed one.
       */
      const mode = await runtimeMode();
      if (cancelled) return;
      if (mode !== "local") {
        setStatus({ phase: "idle" });
        return;
      }
      await poll();
    })();

    return () => {
      cancelled = true;
      controller.abort();
      if (timer !== undefined) clearTimeout(timer);
    };
  }, [threadId, agentId]);

  return status;
}
