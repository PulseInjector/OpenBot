import { tryClient } from "@/lib/client";

/**
 * Which runtime answers this deployment, as `/api/capabilities` reports it.
 *
 * Anything other than an exact `local` keeps the Intelligence path, so a server that is too old to
 * answer, or one that failed to, behaves as it always did.
 */
export type RuntimeMode = "local" | "intelligence";

/**
 * The mode cannot change without the server restarting, so one read per page load is enough.
 *
 * The transport is the cache key: a new `fetch` means a different server to ask, which keeps a
 * caller that installs its own transport from reading the previous one's answer.
 */
const modes = new WeakMap<typeof fetch, Promise<RuntimeMode>>();

export function runtimeMode(signal?: AbortSignal): Promise<RuntimeMode> {
  const transport = globalThis.fetch;
  const cached = modes.get(transport);
  if (cached) return cached;

  const mode = readRuntimeMode(signal).catch(() => {
    // A failed probe is not an answer. The next read asks again rather than staying wrong.
    modes.delete(transport);
    return "intelligence" as const;
  });
  modes.set(transport, mode);
  return mode;
}

async function readRuntimeMode(signal?: AbortSignal): Promise<RuntimeMode> {
  const response = await tryClient("/api/capabilities", { signal });
  if (!response.ok) throw new Error("Capabilities were not readable.");
  const body: unknown = await response.json();
  return typeof body === "object" &&
    body !== null &&
    "mode" in body &&
    body.mode === "local"
    ? "local"
    : "intelligence";
}
