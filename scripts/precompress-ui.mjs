import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { brotliCompress, constants, gzip } from "node:zlib";

const brotli = promisify(brotliCompress);
const gzipAsync = promisify(gzip);

/** Only Vite content-hashed JS/CSS, never HTML, source maps, or runtime config. */
export async function precompressUi(dist) {
  const assets = path.join(dist, "assets");
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const filename = path.join(directory, entry.name);
      if (entry.isDirectory()) { await visit(filename); continue; }
      if (!entry.isFile() || !/[.-][\w-]{8,}\.(?:js|css)$/.test(entry.name)) continue;
      const source = await readFile(filename);
      for (const [suffix, compress] of [
        [".br", () => brotli(source, { params: { [constants.BROTLI_PARAM_QUALITY]: 11 } })],
        [".gz", () => gzipAsync(source, { level: 9 })],
      ]) {
        const output = source.length >= 1024 ? await compress() : null;
        if (output && output.length < source.length) await writeFile(filename + suffix, output);
        else await rm(filename + suffix, { force: true });
      }
    }
  }
  // Missing assets are a build error, not a successful empty compression pass.
  await visit(assets);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await precompressUi(path.resolve(process.argv[2] ?? "ui/dist"));
}
