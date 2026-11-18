import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { brotliDecompressSync, gunzipSync } from "node:zlib";
import { test } from "vitest";
import assert from "node:assert/strict";
import { precompressUi } from "../../scripts/precompress-ui.mjs";

test("precompresses only useful hashed JS/CSS and preserves originals", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "paperclip-precompress-build-"));
  try {
    await mkdir(path.join(root, "assets", "nested"), { recursive: true });
    const source = "export const greeting = 'hello';\n".repeat(2000);
    const files = {
      "assets/board-Abc_1234.js": source,
      "assets/nested/board.AbCd1234.css": "body { color: red; }\n".repeat(2000),
      "assets/config.js": source,
      "assets/board-AbCd1234.js.map": source,
      "assets/tiny-AbCd1234.js": "export {};",
      "assets/random-AbCd1234.js": randomBytes(4096),
      "index.html": source,
      "sw.js": source,
    };
    for (const [name, contents] of Object.entries(files)) await writeFile(path.join(root, name), contents);
    await writeFile(path.join(root, "assets/tiny-AbCd1234.js.gz"), "stale");
    await precompressUi(root);
    for (const name of ["assets/board-Abc_1234.js", "assets/nested/board.AbCd1234.css"]) {
      const original = await readFile(path.join(root, name));
      assert.deepEqual(original, Buffer.from(files[name]));
      for (const [extension, decompress] of [[".br", brotliDecompressSync], [".gz", gunzipSync]]) {
        const compressed = await readFile(path.join(root, name + extension));
        assert.ok(compressed.length < original.length);
        assert.deepEqual(decompress(compressed), original);
      }
    }
    const names = await readdir(path.join(root, "assets"));
    assert.deepEqual(names.filter(name => /\.(br|gz)$/.test(name)).sort(),
      ["board-Abc_1234.js.br", "board-Abc_1234.js.gz"]);
    const before = await readFile(path.join(root, "assets/board-Abc_1234.js.gz"));
    await precompressUi(root);
    assert.deepEqual(await readFile(path.join(root, "assets/board-Abc_1234.js.gz")), before);
    await assert.rejects(precompressUi(path.join(root, "missing")));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
