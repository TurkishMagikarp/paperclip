import assert from "node:assert/strict";
import { IncomingMessage, ServerResponse } from "node:http";
import { createRequire } from "node:module";
import { Socket } from "node:net";
import { performance } from "node:perf_hooks";
import express from "express";
import type { Request, Response } from "express";
import { observeIssueListResponseBytes } from "../src/routes/issue-list-response-bytes.js";

const app = express();
const payload = Array.from({ length: 400 }, (_, index) => ({
  id: `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  companyId: "00000000-0000-4000-8000-000000000001",
  identifier: `TASK-${index + 1}`,
  title: `Representative issue ${index + 1}`,
  description: "Issue context, implementation evidence, and next steps. ".repeat(50),
  status: index % 3 === 0 ? "done" : "in_progress",
  priority: "medium",
  createdAt: new Date("2026-11-01T00:00:00Z"),
  updatedAt: new Date("2026-11-06T00:00:00Z"),
  labels: [{ id: "label-1", name: "performance", color: "#123456" }],
  activeRun: null,
  assigneeAgentId: "00000000-0000-4000-8000-000000000002",
}));

function send(mode: "before" | "after", ifNoneMatch?: string) {
  const req = new IncomingMessage(new Socket()) as Request;
  Object.setPrototypeOf(req, app.request);
  req.method = "GET";
  req.headers = ifNoneMatch ? { "if-none-match": ifNoneMatch } : {};
  const res = new ServerResponse(req) as Response;
  Object.setPrototypeOf(res, app.response);
  req.res = res;
  res.req = req;
  let body: Buffer = Buffer.alloc(0);
  let reportedBytes = 0;
  res.end = ((chunk?: string | Buffer) => {
    body = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? "");
    res.emit("finish");
    return res;
  }) as typeof res.end;
  if (mode === "before") {
    const bytes = Buffer.byteLength(JSON.stringify(payload), "utf8");
    res.once("finish", () => { reportedBytes = bytes; });
  } else {
    const bytes = observeIssueListResponseBytes(res);
    res.once("finish", () => { reportedBytes = bytes(); });
  }
  res.json(payload);
  return { body, etag: String(res.getHeader("etag")), status: res.statusCode, reportedBytes };
}

const before = send("before");
const after = send("after");
assert.deepEqual(after, before);
assert.equal(send("after", after.etag).status, 304);
assert.equal(send("after", after.etag).reportedBytes, 0);

const iterations = 20;
const rounds = 15;
function sample(mode: "before" | "after", conditional: boolean) {
  const cpu = process.cpuUsage();
  const start = performance.now();
  for (let index = 0; index < iterations; index += 1) {
    send(mode, conditional ? after.etag : undefined);
  }
  const elapsed = performance.now() - start;
  const used = process.cpuUsage(cpu);
  return { wallMs: elapsed / iterations, cpuMs: (used.user + used.system) / 1000 / iterations };
}

function median(values: number[]) {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

const results = [];
for (const conditional of [false, true]) {
  for (let warmup = 0; warmup < 20; warmup += 1) {
    send("before", conditional ? after.etag : undefined);
    send("after", conditional ? after.etag : undefined);
  }
  const samples = { before: [] as ReturnType<typeof sample>[], after: [] as ReturnType<typeof sample>[] };
  for (let round = 0; round < rounds; round += 1) {
    const order = round % 2 === 0 ? ["before", "after"] as const : ["after", "before"] as const;
    for (const mode of order) samples[mode].push(sample(mode, conditional));
  }
  const summarize = (mode: "before" | "after") => ({
    wallMs: median(samples[mode].map((value) => value.wallMs)),
    cpuMs: median(samples[mode].map((value) => value.cpuMs)),
  });
  const baseline = summarize("before");
  const optimized = summarize("after");
  results.push({
    scenario: conditional ? "unchanged-full-list-304" : "full-list-200",
    before: baseline,
    after: optimized,
    wallReductionPercent: (1 - optimized.wallMs / baseline.wallMs) * 100,
    cpuReductionPercent: (1 - optimized.cpuMs / baseline.cpuMs) * 100,
  });
}
console.log(JSON.stringify({
  node: process.version,
  platform: `${process.platform}/${process.arch}`,
  express: createRequire(import.meta.url)("express/package.json").version,
  fixtureRows: payload.length,
  fixtureBytes: after.body.length,
  rounds,
  iterationsPerRound: iterations,
  scope: "In-process response serialization and send only; no DB, enrichment, socket IO, or production traffic.",
  results,
}, null, 2));
