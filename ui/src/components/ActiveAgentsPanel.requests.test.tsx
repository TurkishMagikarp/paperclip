// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ISSUE_SUMMARIES_MAX_IDS } from "@paperclipai/shared";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { ActiveAgentsPanel } from "./ActiveAgentsPanel";
import { queryKeys } from "../lib/queryKeys";

vi.mock("@/context/CompanyContext", () => ({
  useCompany: () => ({ selectedCompany: { issuePrefix: "PAP" } }),
}));
vi.mock("./RunChatSurface", () => ({ RunChatSurface: () => null }));
vi.mock("./transcript/useLiveRunTranscripts", () => ({
  useLiveRunTranscripts: () => ({ transcriptByRun: new Map(), hasOutputForRun: () => false }),
}));

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let root: Root;
let container: HTMLDivElement;
let client: QueryClient;
let requests: string[];
let omittedIds: Set<string>;
let summariesFail: boolean;
let runIssueIds: string[];

function issueId(index: number) {
  return `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
}

function issue(id: string) {
  const number = Number(id.slice(-12));
  return {
    id, companyId: "company-1", identifier: `PAP-${number}`, title: `Task ${number}`,
    status: "in_review", externalConversationState: "waiting",
    updatedAt: "2026-11-06T00:00:00.000Z",
  };
}

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 30_000 } } });
  client.setQueryData(queryKeys.auth.session, null);
  requests = [];
  omittedIds = new Set();
  summariesFail = false;
  runIssueIds = [1, 1, 2, 3, 4, 5].map(issueId);
  vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input), "http://localhost");
    requests.push(`${url.pathname}${url.search}`);
    if (url.pathname.endsWith("/live-runs")) {
      return Response.json(runIssueIds.map((id, index) => ({
        id: `run-${index}`, issueId: id, agentId: `agent-${index}`, agentName: `Agent ${index}`,
        status: "running", createdAt: "2026-11-06T00:00:00.000Z",
      })));
    }
    if (url.pathname.endsWith("/summaries")) {
      if (summariesFail) return Response.json({ error: "Forbidden" }, { status: 403 });
      return Response.json(url.searchParams.get("ids")!.split(",").filter(id => !omittedIds.has(id))
        .map(id => ({ ...issue(id), companyId: url.pathname.split("/")[3] })));
    }
    const match = /^\/api\/issues\/([^/]+)$/.exec(url.pathname);
    if (match) return Response.json(issue(match[1]));
    throw new Error(`Unexpected request: ${url}`);
  }));
});

afterEach(async () => {
  await act(async () => root.unmount());
  client.clear();
  container.remove();
  vi.unstubAllGlobals();
});

async function renderPanel(cardLimit = 4, expectedCards = 4, companyId = "company-1") {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <MemoryRouter initialEntries={["/PAP/dashboard"]}>
          <ActiveAgentsPanel companyId={companyId} dedupeLinkedTasks cardLimit={cardLimit} />
        </MemoryRouter>
      </QueryClientProvider>,
    );
  });
  for (let attempt = 0; attempt < 30; attempt++) {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 10)); });
    if (container.querySelectorAll(".dashboard-agent-card").length === expectedCards && !container.textContent?.includes("Loading task")) break;
  }
}

it("loads four dashboard task cards with one summary request and no full-detail GETs", async () => {
  await renderPanel();
  expect(container.querySelectorAll(".dashboard-agent-card")).toHaveLength(4);
  expect([...container.querySelectorAll('a[href*="/issues/"]')].map(a => a.getAttribute("href")))
    .toEqual(["/PAP/issues/PAP-1", "/PAP/issues/PAP-2", "/PAP/issues/PAP-3", "/PAP/issues/PAP-4"]);
  expect(container.querySelectorAll('[aria-label="Task idle"]')).toHaveLength(4);
  expect(requests.filter(path => /^\/api\/issues\/[^/?]+$/.test(path))).toEqual([]);
  expect(requests.filter(path => path.includes("/summaries?")))
    .toEqual([`/api/companies/company-1/issues/summaries?ids=${[1, 2, 3, 4].map(issueId).join("%2C")}`]);
  expect(requests).toHaveLength(2);
  expect(client.getQueryData(queryKeys.issues.detail(issueId(1)))).toBeUndefined();
});

it.each(["omitted", "forbidden"])("keeps %s task cards navigable without falling back to detail GETs", async mode => {
  if (mode === "omitted") omittedIds.add(issueId(2));
  else summariesFail = true;
  await renderPanel();
  expect(container.textContent).toContain("Task unavailable");
  expect(container.textContent).not.toContain("Loading task");
  expect(container.querySelector(`a[href="/PAP/issues/${issueId(2)}"]`)).not.toBeNull();
  expect(requests.filter(path => /^\/api\/issues\/[^/?]+$/.test(path))).toEqual([]);
});

it.each([6, 50, 105])("batches metadata for %i visible live-dashboard cards within the API limit", async count => {
  runIssueIds = Array.from({ length: count }, (_, index) => issueId(index + 1));
  await renderPanel(count, count);
  expect(container.querySelectorAll(".dashboard-agent-card")).toHaveLength(count);
  expect(container.textContent).not.toContain("Loading task");
  const batches = requests.filter(path => path.includes("/summaries?"))
    .map(path => new URL(path, "http://localhost").searchParams.get("ids")!.split(","));
  expect(batches).toHaveLength(Math.ceil(count / ISSUE_SUMMARIES_MAX_IDS));
  expect(batches.every(ids => ids.length <= ISSUE_SUMMARIES_MAX_IDS)).toBe(true);
  if (count === 6) expect(batches.map(ids => ids.length)).toEqual([5, 1]);
  expect(batches.flat().sort()).toEqual([...runIssueIds].sort());
  expect(requests.filter(path => /^\/api\/issues\/[^/?]+$/.test(path))).toEqual([]);
});

it("does not request summaries without linked tasks", async () => {
  runIssueIds = [];
  await renderPanel(4, 0);
  expect(requests).toHaveLength(1);
  expect(container.textContent).toContain("No recent agent runs.");
});

it("does not reuse the previous account's summary cache after an account change", async () => {
  await renderPanel();
  await act(async () => {
    client.setQueryData(queryKeys.auth.session, { user: { id: "another-user" } });
  });
  await renderPanel();
  expect(requests.filter(path => path.includes("/summaries?"))).toHaveLength(2);
});

it("keeps summary requests and cache entries scoped to the selected company", async () => {
  await renderPanel();
  await renderPanel(4, 4, "company-2");
  const summaryPaths = requests.filter(path => path.includes("/summaries?"));
  expect(summaryPaths).toHaveLength(2);
  expect(summaryPaths[0]).toMatch(/^\/api\/companies\/company-1\/issues\/summaries\?ids=/);
  expect(summaryPaths[1]).toMatch(/^\/api\/companies\/company-2\/issues\/summaries\?ids=/);
  const ids = [1, 2, 3, 4].map(issueId);
  expect(client.getQueryData(queryKeys.issues.summaryBatch("company-1", null, ids)))
    .toEqual(ids.map(issue));
  expect(client.getQueryData(queryKeys.issues.summaryBatch("company-2", null, ids)))
    .toEqual(ids.map(id => ({ ...issue(id), companyId: "company-2" })));
});

it("does not read task summaries when the account session is unresolved", async () => {
  client.removeQueries({ queryKey: queryKeys.auth.session });
  await renderPanel();
  expect(requests.some(path => path.includes("/summaries?"))).toBe(false);
  expect(requests.filter(path => /^\/api\/issues\/[^/?]+$/.test(path))).toEqual([]);
});
