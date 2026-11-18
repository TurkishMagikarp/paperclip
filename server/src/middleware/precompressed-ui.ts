import express, { type RequestHandler } from "express";
import { stat } from "node:fs/promises";
import path from "node:path";

/** Sidecars are implementation details, not public download URLs. */
export const blockUiSidecars: RequestHandler = (req, res, next) => {
  let pathname: string;
  try { pathname = decodeURIComponent(req.path); }
  catch { res.status(400).end(); return; }
  if (/\.(?:br|gz)(?:[\\/]|$)/i.test(pathname)) { res.status(404).end(); return; }
  next();
};

/** Use Express's file transport for cache validators, HEAD, and stream errors. */
export function precompressedUiFiles(
  root: string,
  options: Parameters<typeof express.static>[1] = {},
): RequestHandler {
  const fileOptions: Parameters<typeof express.static>[1] = {
    ...options,
    setHeaders(res, filename, info) {
      options?.setHeaders?.(res, filename, info);
      if (/[.-][\w-]{8,}\.(?:js|css)$/.test(filename)) {
        const vary = String(res.getHeader("Vary") ?? "");
        if (!/(?:^|,)\s*(?:Accept-Encoding|\*)\s*(?:,|$)/i.test(vary)) {
          res.setHeader("Vary", vary ? `${vary}, Accept-Encoding` : "Accept-Encoding");
        }
      }
    },
  };
  const identity = express.static(root, fileOptions);
  const encoded = (encoding: "br" | "gzip", suffix: string) => express.static(root, {
    ...options,
    setHeaders(res, filename, info) {
      fileOptions.setHeaders?.(res, filename.slice(0, -suffix.length), info);
      res.setHeader("Content-Encoding", encoding);
      res.setHeader("Content-Type", filename.endsWith(`.css${suffix}`) ? "text/css; charset=utf-8" : "text/javascript; charset=utf-8");
      // Even equal-size, equal-mtime sidecars must not share validators.
      if (options?.etag !== false) {
        res.setHeader("ETag", `W/"${info.size.toString(16)}-${info.mtimeMs.toString(16)}-${encoding}"`);
      }
    },
  });
  const representations = [
    { encoding: "br", suffix: ".br", serve: encoded("br", ".br") },
    { encoding: "gzip", suffix: ".gz", serve: encoded("gzip", ".gz") },
  ] as const;
  return async (req, res, next) => {
    let pathname: string;
    try { pathname = decodeURIComponent(req.path); }
    catch { identity(req, res, next); return; }
    if (/\.(?:br|gz)(?:[\\/]|$)/i.test(pathname)) { res.status(404).end(); return; }
    if (!["GET", "HEAD"].includes(req.method) || !/[.-][\w-]{8,}\.(?:js|css)$/.test(pathname)
      || pathname.split(/[\\/]/).some(part => part === ".." || part.startsWith("."))) {
      identity(req, res, next);
      return;
    }
    res.vary("Accept-Encoding");
    // Keep ranges on identity, including If-Range and unsatisfiable ranges.
    if (req.headers.range || !req.headers["accept-encoding"]) { identity(req, res, next); return; }
    const filename = path.resolve(root, "." + pathname);
    // Legacy/incomplete builds and unreadable originals use the existing path.
    const source = await stat(filename).catch(() => null);
    if (!source?.isFile()) { identity(req, res, next); return; }
    const available = (await Promise.all(representations.map(async representation => {
      const sidecar = await stat(filename + representation.suffix).catch(() => null);
      return sidecar?.isFile() && sidecar.size < source.size && sidecar.mtimeMs >= source.mtimeMs ? representation : null;
    }))).filter(value => value !== null);
    const choice = req.acceptsEncodings(...available.map(value => value.encoding), "identity");
    const selected = available.find(value => value.encoding === choice);
    if (!selected) { identity(req, res, next); return; }
    const originalUrl = req.url;
    const query = originalUrl.indexOf("?");
    req.url = query < 0 ? originalUrl + selected.suffix
      : originalUrl.slice(0, query) + selected.suffix + originalUrl.slice(query);
    // serve-static captures the path synchronously. Restore it before any
    // downstream middleware sees the request (including a removed sidecar).
    try {
      selected.serve(req, res, error => {
        req.url = originalUrl;
        if (error) next(error);
        else identity(req, res, next);
      });
    } finally { req.url = originalUrl; }
  };
}
