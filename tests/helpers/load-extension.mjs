/**
 * Loads the extension through `stripTypeScriptTypes`, mirroring how the other
 * regression tests import it.
 *
 * The extension imports sibling modules (`./recording-source.ts`), so a bare
 * copy of `index.ts` into a temp dir cannot resolve them. Every file beside the
 * entry point is copied too, which keeps those relative imports working.
 */

import { readFile, writeFile, mkdtemp, readdir } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const EXTENSIONS_DIR = new URL("../../extensions/", import.meta.url);

/**
 * Copies and type-strips every `.ts` file in `extensions/` into a temp dir,
 * then imports `entry`.
 *
 * `transform`, when given, receives each file's source and may rewrite it; it
 * is how a test can instrument the entry point before it is compiled.
 */
export async function loadExtensionModule({
  entry = "index.ts",
  prefix = "pi-superwhisper-paste-test",
  transform,
} = {}) {
  const tempDir = await mkdtemp(join(tmpdir(), `${prefix}-`));
  const files = (await readdir(EXTENSIONS_DIR)).filter((name) => name.endsWith(".ts"));

  for (const name of files) {
    const source = await readFile(new URL(name, EXTENSIONS_DIR), "utf8");
    const rewritten = transform ? transform(source, name) : source;
    const compiled = stripTypeScriptTypes(rewritten, { mode: "strip" });
    await writeFile(join(tempDir, name.replace(/\.ts$/, ".mjs")), compiled, "utf8");
  }

  // The copies are `.mjs`, so relative `./x.ts` imports must point at `./x.mjs`.
  for (const name of files) {
    if (!name.endsWith(".ts")) continue;
    const path = join(tempDir, name.replace(/\.ts$/, ".mjs"));
    const source = await readFile(path, "utf8");
    const fixed = source.replace(/(from\s+"\.\/[^"]+)\.ts"/g, '$1.mjs"');
    if (fixed !== source) await writeFile(path, fixed, "utf8");
  }

  const modulePath = join(tempDir, entry.replace(/\.ts$/, ".mjs"));
  return {
    module: await import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`),
    cleanup: async () => {
      const { rm } = await import("node:fs/promises");
      await rm(tempDir, { recursive: true, force: true });
    },
  };
}
