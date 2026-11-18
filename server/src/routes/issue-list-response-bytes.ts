import type { Response } from "express";

export function observeIssueListResponseBytes(res: Response): () => number {
  let bytes = 0;
  const originalSend = res.send;
  res.send = function (this: Response, body: unknown) {
    if (typeof body === "string") {
      bytes = Buffer.byteLength(body, "utf8");
    } else if (Buffer.isBuffer(body)) {
      bytes = body.length;
    }
    return originalSend.call(this, body);
  } as typeof res.send;
  return () => res.statusCode === 204 || res.statusCode === 304 ? 0 : bytes;
}
