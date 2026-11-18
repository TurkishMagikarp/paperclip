import express from "express";
import { createServer, request, type IncomingHttpHeaders } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtemp, mkdir, rm, writeFile, readFile, utimes } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { brotliCompressSync, brotliDecompressSync, gzipSync, gunzipSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { blockUiSidecars } from "../middleware/precompressed-ui.js";
import { staticUiFiles } from "../middleware/static-ui.js";
import { staticUiCompression } from "../middleware/static-ui-compression.js";

const source = "export const message = 'precompressed static UI fixture';\n".repeat(2000);
let root: string;
let server: ReturnType<typeof createServer>;
let port: number;
const js = "/assets/board-AbCd1234.js";
const sidecars = { br: brotliCompressSync(source), gzip: gzipSync(source, { level: 9 }) };

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "paperclip-precompressed-"));
  const assets = path.join(root, "assets");
  await mkdir(assets);
  for (const name of ["board-AbCd1234.js", "style-AbCd1234.css", "legacy-AbCd1234.js",
    "stale-AbCd1234.js", "gziponly-AbCd1234.js", "config.js"]) {
    await writeFile(path.join(assets, name), source);
    if (name.startsWith("legacy")) continue;
    await writeFile(path.join(assets, name + ".gz"), sidecars.gzip);
    if (!name.startsWith("gziponly")) await writeFile(path.join(assets, name + ".br"), sidecars.br);
    if (name.startsWith("stale")) {
      await utimes(path.join(assets, name + ".gz"), 1, 1);
      await utimes(path.join(assets, name + ".br"), 1, 1);
    }
  }
  await writeFile(path.join(assets, "orphan-AbCd1234.js.br"), sidecars.br);
  const app = express();
  app.get("/api/private", (_req, res) => res.status(401).json({ error: "unauthorized" }));
  const ui = express.Router();
  ui.use(blockUiSidecars);
  ui.use(staticUiCompression());
  ui.use("/without-validators", staticUiFiles(assets, { etag: false, lastModified: false, maxAge: 0 }));
  ui.use("/assets", staticUiFiles(assets, {
    maxAge: "1y", immutable: true,
    setHeaders(res, filename) {
      res.setHeader("X-Original-File", path.basename(filename));
      res.setHeader("Vary", "Origin");
    },
  }));
  // Mirrors the root static mount and SPA fallback in app.ts.
  ui.use(staticUiFiles(root, { maxAge: "1h" }));
  ui.get(/.*/, (req, res) => req.path.startsWith("/assets/") ? res.status(404).end() : res.type("html").send("shell"));
  app.use(ui);
  server = createServer(app);
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  port = (server.address() as AddressInfo).port;
});
afterAll(async () => {
  await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  await rm(root, { recursive: true, force: true });
});
function get(url = js, headers: Record<string, string> = {}, method = "GET") {
  return new Promise<{ status: number; headers: IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, path: url, headers, method }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(Buffer.from(chunk)));
      res.on("error", reject);
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
    });
    req.on("error", reject);
    req.end();
  });
}
describe("precompressed UI transport", () => {
  it.each(["br", "gzip"] as const)("serves exact %s sidecar bytes, MIME, cache and length (not dynamic compression)", async encoding => {
    const res = await get(js + "?v=test", { "Accept-Encoding": encoding });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sidecars[encoding]);
    expect(res.headers["content-encoding"]).toBe(encoding);
    expect(res.headers["content-length"]).toBe(String(sidecars[encoding].length));
    expect(res.headers["content-type"]).toContain("javascript");
    expect(res.headers["cache-control"]).toBe("public, max-age=31536000, immutable");
    expect(res.headers["x-original-file"]).toBe("board-AbCd1234.js");
    expect(res.headers.vary).toContain("Origin");
    expect(res.headers.vary).toContain("Accept-Encoding");
    expect((encoding === "br" ? brotliDecompressSync(res.body) : gunzipSync(res.body)).toString()).toBe(source);
  });
  it.each([
    ["br, gzip", "br"], ["br;q=0, gzip", "gzip"], ["br;q=0.2, gzip;q=0.8", "gzip"],
    ["gzip;q=0, br", "br"], ["*;q=1", "br"], ["br;q=0, *;q=1", "gzip"],
    ["identity", undefined], ["br;q=0, gzip;q=0", undefined], ["identity;q=1, br;q=0.5", undefined],
  ])("negotiates %s", async (accept, expected) => {
    const res = await get(js, { "Accept-Encoding": accept! });
    expect(res.headers["content-encoding"]).toBe(expected);
    if (!expected) expect(res.body.toString()).toBe(source);
  });
  it("uses identity when the header is absent and varies identity responses", async () => {
    const res = await get();
    expect(res.body.toString()).toBe(source);
    expect(res.headers["content-encoding"]).toBeUndefined();
    expect(res.headers.vary).toContain("Accept-Encoding");
  });
  it("uses gzip when Brotli is absent and preserves legacy dynamic fallback", async () => {
    const gzip = await get("/assets/gziponly-AbCd1234.js", { "Accept-Encoding": "br, gzip" });
    expect(gzip.body).toEqual(sidecars.gzip);
    for (const name of ["legacy", "stale"]) {
      const res = await get(`/assets/${name}-AbCd1234.js`, { "Accept-Encoding": "br" });
      expect(res.headers["content-length"]).toBeUndefined();
      expect(brotliDecompressSync(res.body).toString()).toBe(source);
    }
  });
  it("preserves CSS type and ignores non-hashed sidecars", async () => {
    expect((await get("/assets/style-AbCd1234.css", { "Accept-Encoding": "br" })).headers["content-type"]).toContain("text/css");
    expect((await get("/assets/config.js", { "Accept-Encoding": "br" })).headers["content-length"]).toBeUndefined();
  });
  it("honors caller options that disable validators or immutable caching", async () => {
    const res = await get("/without-validators/board-AbCd1234.js", { "Accept-Encoding": "br" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual(sidecars.br);
    expect(res.headers.etag).toBeUndefined();
    expect(res.headers["last-modified"]).toBeUndefined();
    expect(res.headers["cache-control"]).toBe("public, max-age=0");
  });
  it("uses distinct validators for all representations, with HEAD and conditional responses", async () => {
    const identity = await get(js, { "Accept-Encoding": "identity" });
    const br = await get(js, { "Accept-Encoding": "br" });
    const gzip = await get(js, { "Accept-Encoding": "gzip" });
    expect(new Set([identity.headers.etag, br.headers.etag, gzip.headers.etag]).size).toBe(3);
    for (const encoding of ["br", "gzip"] as const) {
      const cached = encoding === "br" ? br : gzip;
      const head = await get(js, { "Accept-Encoding": encoding }, "HEAD");
      expect(head.status).toBe(200);
      expect(head.body.length).toBe(0);
      expect(head.headers["content-length"]).toBe(cached.headers["content-length"]);
      const fresh = await get(js, { "Accept-Encoding": encoding, "If-None-Match": cached.headers.etag! });
      expect(fresh.status).toBe(304);
      expect(fresh.body.length).toBe(0);
      expect(fresh.headers.vary).toContain("Accept-Encoding");
      expect((await get(js, { "Accept-Encoding": encoding, "If-None-Match": identity.headers.etag! })).status).toBe(200);
      expect((await get(js, { "Accept-Encoding": encoding, "If-Modified-Since": cached.headers["last-modified"]! })).status).toBe(304);
    }
  });
  it("preserves identity ranges, If-Range, 416 and preconditions", async () => {
    const partial = await get(js, { "Accept-Encoding": "br, gzip", Range: "bytes=0-31" });
    expect(partial.status).toBe(206);
    expect(partial.headers["content-encoding"]).toBeUndefined();
    expect(partial.headers["content-range"]).toBe(`bytes 0-31/${Buffer.byteLength(source)}`);
    expect(partial.body.toString()).toBe(source.slice(0, 32));
    const modified = await get(js, { "Accept-Encoding": "br", Range: "bytes=0-31", "If-Range": '"different"' });
    expect(modified.status).toBe(200);
    expect(modified.headers["content-encoding"]).toBeUndefined();
    expect(modified.body.toString()).toBe(source);
    expect((await get(js, { "Accept-Encoding": "br", Range: "bytes=99999999-" })).status).toBe(416);
    expect((await get(js, { "Accept-Encoding": "br", "If-Match": '"different"' })).status).toBe(412);
  });
  it.each([js + ".br", js + ".gz", js + "%2ebr?raw=1", js + ".gz/extra", "/secret.gz", "/assets/%2e%2e/secret.gz"])("blocks raw sidecar URL %s", async url => {
    const res = await get(url, { "Accept-Encoding": "br" });
    expect(res.status).toBe(404);
    expect(res.body.length).toBe(0);
  });
  it("keeps API auth, missing assets, malformed paths and orphan sidecars safe", async () => {
    const api = await get("/api/private", { "Accept-Encoding": "br" });
    expect(api.status).toBe(401);
    expect(api.headers["content-encoding"]).toBeUndefined();
    expect((await get("/assets/missing-AbCd1234.js", { "Accept-Encoding": "br" })).status).toBe(404);
    expect((await get("/assets/orphan-AbCd1234.js", { "Accept-Encoding": "br" })).status).toBe(404);
    expect((await get("/assets/%zz", { "Accept-Encoding": "br" })).status).toBe(400);
    expect(await readFile(path.join(root, "assets/board-AbCd1234.js"), "utf8")).toBe(source);
  });
});
