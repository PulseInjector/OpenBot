import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import { QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ProposedBotRender } from "@/lib/copilot/bot-tools";
import { queryClient } from "@/query-client";

beforeAll(() => GlobalRegistrator.register());
const originalFetch = globalThis.fetch;
afterEach(() => {
  cleanup();
  queryClient.clear();
  globalThis.fetch = originalFetch;
});
afterAll(() => GlobalRegistrator.unregister());
const proposal = {
  name: "Compatibility Desk",
  title: "Research",
  roleDescription: "Read compatibility notes and cite their sources.",
  skills: ["read-docs", "check-facts"],
};

test("the transcript renderer re-reads grants and retries only confirmed missing skills after remount", async () => {
  const creates: unknown[] = [];
  const attempts: string[] = [];
  const held = new Set<string>();
  let grantReads = 0;
  let fail = true;
  globalThis.fetch = Object.assign(
    async (path: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const body = init?.body ? JSON.parse(String(init.body)) : undefined;
      if (path === "/api/agents" && init?.method === "POST") {
        creates.push(body);
        return Response.json(
          { agent: { id: "bot-retry", name: proposal.name } },
          { status: 201 },
        );
      }
      if (path === "/api/agents") return Response.json({ agents: [] });
      if (path === "/api/plugins/for/bot-retry") {
        grantReads++;
        return Response.json({
          skills: [...held].map((slug) => ({ slug })),
          servers: [],
          bots: [],
        });
      }
      if (path === "/api/plugins/grants") {
        attempts.push(body.ref);
        // The first skill commits but its response is lost. The other fails before commit.
        if (body.ref === "read-docs") held.add(body.ref);
        if (fail)
          return Response.json(
            { error: "Injected grant failure" },
            { status: 500 },
          );
        held.add(body.ref);
        return Response.json({});
      }
      return new Response(null, { status: 404 });
    },
    { preconnect: originalFetch.preconnect },
  );
  const answers: unknown[] = [];
  const draw = () =>
    render(
      <QueryClientProvider client={queryClient}>
        <ProposedBotRender
          args={proposal}
          toolCallId="durable-call"
          respond={async (result) => {
            answers.push(result);
          }}
        />
      </QueryClientProvider>,
    );
  const first = draw();
  await userEvent.click(await first.findByText("Create it"));
  await first.findByRole("alert");
  expect(answers).toEqual([]);
  expect([...held]).toEqual(["read-docs"]);
  first.unmount();
  // An unrelated skill appearing between attempts must never enter the retry.
  held.add("unrelated-skill");
  fail = false;
  const second = draw();
  await userEvent.click(await second.findByText("Create it"));
  await waitFor(() => expect(answers).toHaveLength(1));
  expect(grantReads).toBe(2);
  expect(attempts).toEqual(["read-docs", "check-facts", "check-facts"]);
  expect(creates).toHaveLength(2);
  expect(creates[0]).toEqual(creates[1]);
  expect(creates[0]).toMatchObject({
    requestId: "save_bot:durable-call",
    confirmation: { skills: proposal.skills, apps: [] },
  });
  expect(String(answers[0])).not.toContain("unrelated-skill");
});

test("a confirmation without a durable transcript tool-call ID offers no create control", async () => {
  const view = render(
    <QueryClientProvider client={queryClient}>
      <ProposedBotRender args={proposal} respond={async () => {}} />
    </QueryClientProvider>,
  );
  expect(await view.findByText("Writing the Bot…")).toBeTruthy();
  expect(view.queryByRole("button")).toBeNull();
});
