# Static UI precompression

`pnpm --filter @paperclipai/ui build` runs `vite build`, then
`node ../scripts/precompress-ui.mjs dist`. The script uses only Node built-ins.
It creates Brotli quality 11 and gzip level 9 sidecars next to content-hashed
JS/CSS under `dist/assets/`. Files smaller than 1 KiB, ineffective compressed
outputs, HTML, service workers, source maps, and non-hashed config files are
excluded. Originals remain unchanged. The normal server package preparation
copies the entire UI output, including sidecars, to `server/ui-dist/`.

`server/src/middleware/precompressed-ui.ts` owns transport selection.
`staticUiFiles()` delegates to `precompressedUiFiles(root, options)` and keeps
its existing idle-response accounting. No setting, auth handler, API mount,
HTML transformation, or cache duration changes.

- Requests without `Accept-Encoding` use the original file.
- Express negotiates available encodings, including quality values and identity.
  Equal preferences favor Brotli, then gzip.
- Each candidate uses asynchronous file metadata reads, not synchronous reads
  or request-time compression. Missing, older-than-original, or ineffective
  sidecars fall back to the original transport and existing dynamic compression.
  Deploy matching originals and sidecars together; preserve timestamps when
  copying them, or regenerate sidecars after copying originals.
- Encoded responses retain the original MIME type and cache options. Their
  ETags include the encoding. Express handles HEAD and conditional requests.
  All eligible responses vary on `Accept-Encoding`, including identity and 304.
- Requests with `Range` stay on identity, including `If-Range` and 416 responses.
- `blockUiSidecars` runs before all static UI mounts and the SPA fallback.
  Raw `.br`/`.gz` URLs return 404, including encoded suffixes. The file middleware
  also rejects them. Shared retained assets neither publish nor serve sidecars;
  retained original chunks keep their existing dynamic compression.

## Adapting an installed npm server

Do not replace the installed server with a source build from a different
version. Do not copy instance config, environment files, databases, or auth
state. Apply the following narrow changes to the installed version instead:

1. Compile `server/src/middleware/precompressed-ui.ts` as ESM to
   `<server-package>/dist/middleware/precompressed-ui.js`. It needs only Node
   built-ins and the server's existing `express` dependency.
2. In `dist/middleware/static-ui.js`, import `precompressedUiFiles` from
   `./precompressed-ui.js`. Replace only the `express.static(root, {...})`
   factory call with `precompressedUiFiles(root, {...})`. Keep the options,
   callbacks, idle accounting, and surrounding request flow.
3. In `dist/app.js`, import `blockUiSidecars` from
   `./middleware/precompressed-ui.js`. Insert
   `staticUi.use(blockUiSidecars)` immediately before the existing
   `staticUi.use(staticUiCompression())`. Leave the `/assets` mount, auth
   ordering, dynamic compression, root static mount, and SPA fallback in place.
4. Run `node /path/to/precompress-ui.mjs <server-package>/ui-dist` against the
   **installed version's own UI output**, or generate sidecars in its matching
   build artifact before installation. The script accepts the directory that
   contains `assets/`, not `assets/` itself. The script does not need to remain
   installed at runtime.
5. If that installed version supports shared retained UI assets, backport the
   `.br`/`.gz` exclusions in `retained-ui-assets` too.

The source and usual published layouts resolve the UI at `server/ui-dist/`
from `server/dist/app.js`, with `ui/dist/` as the monorepo fallback. Confirm the
actual package root before patching. For a different or bundled layout, apply
the equivalent changes to that version's static middleware; do not assume a
`dist/middleware/` module exists.

Verify on an isolated copy first. With compression disabled in the HTTP client,
check exact sidecar bytes and `Content-Length`, decoded equality to the
original, cache and MIME headers, HEAD, 304, identity ranges, missing chunks,
and raw-sidecar 404s. Keep a rollback copy of the modified package files and
restart only through the deployment owner's normal process. This source
change does not perform installation, deployment, or service restarts.
