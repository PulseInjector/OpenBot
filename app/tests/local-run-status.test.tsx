import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  jest,
  test,
} from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  act,
  cleanup,
  render,
  renderHook,
  waitFor,
} from "@testing-library/react";
import { LocalRunStatusStrip } from "../src/components/local-run-status-strip";
import { useLocalRunStatus } from "../src/lib/copilot/local-run-status";

const threadId = "local-thread";
const agentId = "local-bot";
const runId = "run-1";

type FetchHandler = (
  ...args: Parameters<typeof globalThis.fetch>
) => ReturnType<typeof globalThis.fetch>;

async function withFetch(handler: FetchHandler, run: () => Promise<void>) {
  const original = globalThis.fetch;
  globalThis.fetch = Object.assign(handler, {
    preconnect: original.preconnect,
  });
  try {
    await run();
  } finally {
    globalThis.fetch = original;
  }
}

function pathOf(input: Parameters<typeof fetch>[0]) {
  return new URL(
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.href
        : input.url,
    "http://localhost",
  ).pathname;
}

/**
 * Let the hook's awaited fetches resolve. React's `act` flushes the updates they schedule; the
 * promise turns are what an already-resolved mock fetch needs to reach its `setStatus`.
 */
async function flushMicrotasks() {
  await act(async () => {
    for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
  });
}

async function advance(ms: number) {
  await act(async () => {
    jest.advanceTimersByTime(ms);
    for (let turn = 0; turn < 32; turn += 1) await Promise.resolve();
  });
}

/** A local stack answering capabilities, then the given status bodies in order. */
function localStatuses(bodies: unknown[]): FetchHandler {
  let index = 0;
  return async (input) => {
    const path = pathOf(input);
    if (path === "/api/capabilities") {
      return Response.json({ mode: "local", durableHistory: true });
    }
    if (path === `/api/local-runtime/threads/${threadId}/status`) {
      const body = bodies[Math.min(index, bodies.length - 1)];
      index += 1;
      return Response.json(body);
    }
    throw new Error(`Unexpected fixture request: ${path}`);
  };
}

beforeAll(() => GlobalRegistrator.register());
afterEach(() => {
  cleanup();
  jest.useRealTimers();
});
afterAll(() => GlobalRegistrator.unregister());

describe("local run status hook", () => {
  test("polls a live run once a second and stops at the first terminal phase", async () => {
    const bodies = [
      { status: { phase: "running", runId } },
      { status: { phase: "running", runId } },
      { status: { phase: "succeeded", runId } },
    ];
    let statusReads = 0;
    let capabilityReads = 0;

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        if (path === "/api/capabilities") {
          capabilityReads += 1;
          return Response.json({ mode: "local" });
        }
        if (path === `/api/local-runtime/threads/${threadId}/status`) {
          const body = bodies[Math.min(statusReads, bodies.length - 1)];
          statusReads += 1;
          return Response.json(body);
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        jest.useFakeTimers();
        const { result, unmount } = renderHook(() =>
          useLocalRunStatus(threadId, agentId),
        );

        await flushMicrotasks();
        expect(result.current).toEqual({ phase: "running", runId });
        expect(statusReads).toBe(1);

        await advance(1000);
        expect(result.current).toEqual({ phase: "running", runId });
        expect(statusReads).toBe(2);

        await advance(1000);
        expect(result.current).toEqual({ phase: "succeeded", runId });
        expect(statusReads).toBe(3);

        await advance(5000);
        expect(statusReads).toBe(3);
        expect(capabilityReads).toBe(1);
        unmount();
      },
    );
  });

  test("an idle thread is read once and never polled", async () => {
    let statusReads = 0;

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "local" });
        }
        if (path === `/api/local-runtime/threads/${threadId}/status`) {
          statusReads += 1;
          return Response.json({ status: { phase: "idle" } });
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        jest.useFakeTimers();
        const { result, unmount } = renderHook(() =>
          useLocalRunStatus(threadId, agentId),
        );

        await flushMicrotasks();
        expect(result.current).toEqual({ phase: "idle" });

        await advance(5000);
        expect(statusReads).toBe(1);
        unmount();
      },
    );
  });

  test("a status body outside the schema fails closed to unavailable", async () => {
    await withFetch(
      async (input) => {
        const path = pathOf(input);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "local" });
        }
        if (path === `/api/local-runtime/threads/${threadId}/status`) {
          return Response.json({ status: { phase: "finished" } });
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const { result, unmount } = renderHook(() =>
          useLocalRunStatus(threadId, agentId),
        );

        await waitFor(() =>
          expect(result.current).toEqual({ phase: "unavailable" }),
        );
        unmount();
      },
    );
  });

  test("intelligence mode renders no run status and never asks the status route", async () => {
    const paths: string[] = [];

    await withFetch(
      async (input) => {
        const path = pathOf(input);
        paths.push(path);
        if (path === "/api/capabilities") {
          return Response.json({ mode: "intelligence" });
        }
        throw new Error(`Unexpected fixture request: ${path}`);
      },
      async () => {
        const view = render(
          <LocalRunStatusStrip threadId={threadId} agentId={agentId} />,
        );

        await flushMicrotasks();
        expect(paths).toContain("/api/capabilities");
        expect(paths.some((path) => path.endsWith("/status"))).toBe(false);
        expect(view.queryByRole("status")).toBeNull();
        expect(view.queryByRole("alert")).toBeNull();
        expect(view.container.textContent).toBe("");
      },
    );
  });
});

describe("local run status strip", () => {
  test("a live run reads as active", async () => {
    await withFetch(
      localStatuses([{ status: { phase: "running", runId } }]),
      async () => {
        const view = render(
          <LocalRunStatusStrip threadId={threadId} agentId={agentId} />,
        );
        expect(await view.findByText("Run is active")).toBeTruthy();
      },
    );
  });

  test("a finished run reads Run succeeded", async () => {
    await withFetch(
      localStatuses([{ status: { phase: "succeeded", runId } }]),
      async () => {
        const view = render(
          <LocalRunStatusStrip threadId={threadId} agentId={agentId} />,
        );
        expect(await view.findByText("Run succeeded")).toBeTruthy();
      },
    );
  });

  test("a failed run shows the stored reason", async () => {
    const reason = "The model refused the request.";

    await withFetch(
      localStatuses([{ status: { phase: "failed", runId, reason } }]),
      async () => {
        const view = render(
          <LocalRunStatusStrip threadId={threadId} agentId={agentId} />,
        );
        expect(await view.findByText(`Run failed: ${reason}`)).toBeTruthy();
      },
    );
  });

  test("an interrupted run reads Run was interrupted with its stored reason", async () => {
    const reason = "execution lease expired";

    await withFetch(
      localStatuses([{ status: { phase: "interrupted", runId, reason } }]),
      async () => {
        const view = render(
          <LocalRunStatusStrip threadId={threadId} agentId={agentId} />,
        );
        expect(
          await view.findByText(`Run was interrupted: ${reason}`),
        ).toBeTruthy();
      },
    );
  });
});
