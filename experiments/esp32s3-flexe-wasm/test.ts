import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  DEFAULT_FLEXE_SOURCE,
  EXPECTED_WASI_IMPORTS,
  PUCK_WASI_LITE_IMPORTS,
  SOURCE_HASHES
} from "./constants";
import { requireSuccess, run, sha256, verifySource } from "./lib";

const here = import.meta.dir;
const source = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);
const dist = resolve(process.env.FLEXE_WASM_DIST ?? join(here, "dist"));
verifySource(source);

requireSuccess(run([process.execPath, join(here, "build.ts")], here));
requireSuccess(run([process.execPath, join(here, "run.ts")], here));
requireSuccess(run([process.execPath, join(here, "puck-loader-test.ts")], here));
requireSuccess(run([process.execPath, join(here, "dynamic-runner-test.ts")], here));
requireSuccess(run([process.execPath, join(here, "freestanding-blocker.ts")], here));
requireSuccess(run([process.execPath, join(here, "isa-inventory-test.ts")], here));

const module = await WebAssembly.compile(await Bun.file(join(dist, "flexe-probe.wasm")).arrayBuffer());
const imports = WebAssembly.Module.imports(module);
const unexpectedModules = imports.filter((item) => item.module !== "wasi_snapshot_preview1");
if (unexpectedModules.length > 0) {
  throw new Error(`unexpected wasm imports: ${JSON.stringify(unexpectedModules)}`);
}
const names = imports.map((item) => item.name).sort();
if (JSON.stringify(names) !== JSON.stringify([...EXPECTED_WASI_IMPORTS].sort())) {
  throw new Error(`WASI import closure changed: ${JSON.stringify(names)}`);
}

const supported = new Set<string>(PUCK_WASI_LITE_IMPORTS);
const rejectedByPuck = names.filter((name) => !supported.has(name));
if (rejectedByPuck.join(",") !== "environ_get,environ_sizes_get,fd_close,fd_seek") {
  throw new Error(`Puck WASI-lite blocker changed: ${rejectedByPuck.join(",")}`);
}

const trackedLicense = join(here, "LICENSE.flexe");
if (!existsSync(trackedLicense) || sha256(trackedLicense) !== SOURCE_HASHES.LICENSE) {
  throw new Error("tracked flexe license does not match the pinned upstream license");
}
if (readFileSync(join(dist, "LICENSE.flexe"), "utf8") !== readFileSync(trackedLicense, "utf8")) {
  throw new Error("built artifact is missing the exact tracked flexe license");
}

console.log(JSON.stringify({
  sourceFiles: Object.keys(SOURCE_HASHES).length - 1,
  wasiImports: names,
  rejectedByPuck,
  freestandingBytes: Bun.file(join(dist, "flexe-probe-freestanding.wasm")).size,
  result: 42
}, null, 2));
