import { statSync } from "node:fs";
import { join, resolve } from "node:path";
import { instantiate } from "../../src/wasm";
import {
  EXPECTED_FREESTANDING_EXPORTS,
  EXPECTED_FREESTANDING_IMPORTS,
  EXPECTED_RESULT
} from "./constants";

const dist = resolve(process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"));
const path = join(dist, "flexe-probe-freestanding.wasm");
const bytes = await Bun.file(path).arrayBuffer();
const module = await WebAssembly.compile(bytes);

const imports = WebAssembly.Module.imports(module)
  .map((item) => `${item.module}.${item.name}`)
  .sort();
const exports = WebAssembly.Module.exports(module)
  .map((item) => item.name)
  .sort();
if (JSON.stringify(imports) !== JSON.stringify([...EXPECTED_FREESTANDING_IMPORTS].sort())) {
  throw new Error(`freestanding import closure changed: ${JSON.stringify(imports)}`);
}
if (JSON.stringify(exports) !== JSON.stringify([...EXPECTED_FREESTANDING_EXPORTS].sort())) {
  throw new Error(`freestanding export closure changed: ${JSON.stringify(exports)}`);
}

const logs: string[] = [];
const instance = await instantiate(bytes, (text) => logs.push(text));
const probe = (instance as unknown as { flexe_wasm_probe?: () => number }).flexe_wasm_probe;
if (typeof probe !== "function") throw new Error("Puck instantiate() did not expose flexe_wasm_probe");
const result = probe();
if (result !== EXPECTED_RESULT) {
  throw new Error(`expected Puck-loaded flexe probe to return ${EXPECTED_RESULT}, got ${result}`);
}

console.log(JSON.stringify({
  imports,
  exports,
  logs,
  result,
  strippedBytes: statSync(path).size
}));
