// Produces a plain static dist/ (HTML + one bundled JS + CSS), for anyone
// who wants to serve this page from a plain static file server instead of
// `bun run server.ts` (which transpiles src/*.ts to browser JS on request
// via Bun's HTML-import dev bundler, but is not itself a static file, and
// its /api/freeze, /api/trace and /api/livereload routes have no meaning
// under a read-only static host).
//
// The wasm module itself is copied in if it has already been built, so the
// static page still runs; if not, the page shows the missing-module message
// (main.ts's showWasmError / wasm.ts's fetchWasmBytes) rather than a blank
// screen.
import { mkdirSync, rmSync, copyFileSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const SRC = join(ROOT, "src");
const DIST = join(ROOT, "dist");
const WASM_SRC = join(ROOT, "wasm", "dist", "emu.wasm");

if (existsSync(DIST)) rmSync(DIST, { recursive: true, force: true });
mkdirSync(DIST, { recursive: true });

const result = await Bun.build({
  entrypoints: [join(SRC, "main.ts")],
  outdir: DIST,
  naming: "main.js",
  target: "browser",
  format: "esm",
  minify: false,
});
if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

for (const css of ["family-budget.css", "app.css"]) {
  copyFileSync(join(SRC, css), join(DIST, css));
}

if (existsSync(WASM_SRC)) {
  mkdirSync(join(DIST, "wasm"), { recursive: true });
  copyFileSync(WASM_SRC, join(DIST, "wasm", "emu.wasm"));
  console.log("copied wasm/dist/emu.wasm into dist/wasm/");
} else {
  console.log("wasm/dist/emu.wasm not built yet; dist/ will show the missing-module message until it is");
}

const html = readFileSync(join(SRC, "index.html"), "utf8").replace(
  '<script type="module" src="./main.ts"></script>',
  '<script type="module" src="./main.js"></script>'
);
writeFileSync(join(DIST, "index.html"), html);

console.log(`built dist/ (${result.outputs.length} output file(s))`);
