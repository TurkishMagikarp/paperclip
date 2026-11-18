import express from "express";
import compression from "compression";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { observeIssueListResponseBytes } from "../routes/issue-list-response-bytes.js";

describe("issue-list response byte observation", () => {
  it("does not serialize the list again and preserves Express JSON settings and ETags", async () => {
    let serializations = 0;
    const payload = [{ toJSON: () => {
      serializations += 1;
      return { title: "Grüße 🎲 <task>", updatedAt: new Date("2026-11-06T00:00:00Z") };
    } }];
    const app = express();
    app.set("json escape", true);
    app.set("json spaces", 2);
    app.set("json replacer", (key: string, value: unknown) => key === "title" ? `${value}!` : value);
    const sizes: number[] = [];
    app.get("/baseline", (_req, res) => {
      Buffer.byteLength(JSON.stringify(payload), "utf8");
      res.json(payload);
    });
    app.get("/issues", (_req, res) => {
      const bytes = observeIssueListResponseBytes(res);
      res.once("finish", () => sizes.push(bytes()));
      res.json(payload);
    });

    const baseline = await request(app).get("/baseline");
    expect(serializations).toBe(2);
    serializations = 0;
    const first = await request(app).get("/issues");
    expect(serializations).toBe(1);
    expect(first.status).toBe(200);
    expect(first.text).toBe(baseline.text);
    expect(first.headers.etag).toBe(baseline.headers.etag);
    expect(first.headers["content-type"]).toBe(baseline.headers["content-type"]);
    expect(sizes).toEqual([Buffer.byteLength(first.text, "utf8")]);

    const unchanged = await request(app).get("/issues").set("If-None-Match", first.headers.etag);
    expect(unchanged.status).toBe(304);
    expect(unchanged.text).toBe("");
    expect(sizes.at(-1)).toBe(0);
  });

  it("counts the uncompressed JSON bytes when compression removes Content-Length", async () => {
    const app = express();
    app.use(compression());
    const payload = [{ title: "ü".repeat(5_000) }];
    let size: number | undefined;
    let contentLength: unknown;
    app.get("/issues", (_req, res) => {
      const bytes = observeIssueListResponseBytes(res);
      res.once("finish", () => {
        size = bytes();
        contentLength = res.getHeader("content-length");
      });
      res.json(payload);
    });

    const response = await request(app).get("/issues").set("Accept-Encoding", "gzip");
    expect(response.headers["content-encoding"]).toBe("gzip");
    expect(response.body).toEqual(payload);
    expect(contentLength).toBeUndefined();
    expect(size).toBe(Buffer.byteLength(JSON.stringify(payload), "utf8"));
  });

  it("handles explicit 304s, errors, and Buffer sends without changing the response", async () => {
    const app = express();
    const sizes: number[] = [];
    app.use((_req, res, next) => {
      const bytes = observeIssueListResponseBytes(res);
      res.once("finish", () => sizes.push(bytes()));
      next();
    });
    app.get("/not-modified", (_req, res) => res.status(304).end());
    app.get("/limited", (_req, res) => res.status(429).json({ error: "Too many requests" }));
    app.get("/buffer", (_req, res) => res.type("json").send(Buffer.from('{"title":"é"}')));

    expect((await request(app).get("/not-modified")).status).toBe(304);
    const limited = await request(app).get("/limited");
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: "Too many requests" });
    const buffer = await request(app).get("/buffer");
    expect(buffer.body).toEqual({ title: "é" });
    expect(sizes).toEqual([0, Buffer.byteLength(limited.text), Buffer.byteLength(buffer.text)]);
  });
});
