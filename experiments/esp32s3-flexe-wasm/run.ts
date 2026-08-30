import { WASI } from "node:wasi";
import { join, resolve } from "node:path";
import { EXPECTED_RESULT } from "./constants";
import { requireSuccess, run } from "./lib";

const dist = resolve(process.env.FLEXE_WASM_DIST ?? join(import.meta.dir, "dist"));
const native = run([join(dist, "flexe-probe-native")]);
requireSuccess(native);
const nativeResult = Number.parseInt(native.stdout.trim(), 10);

const bytes = await Bun.file(join(dist, "flexe-probe.wasm")).arrayBuffer();
const module = await WebAssembly.compile(bytes);
const wasi = new WASI({ version: "preview1", args: [], env: {} });
const instance = await WebAssembly.instantiate(module, {
  wasi_snapshot_preview1: wasi.wasiImport
});

const memory = instance.exports.memory;
const initialize = instance.exports._initialize;
const probe = instance.exports.flexe_wasm_probe;
if (!(memory instanceof WebAssembly.Memory) || typeof initialize !== "function" || typeof probe !== "function") {
  throw new Error("probe module is missing memory, _initialize, or flexe_wasm_probe exports");
}

(wasi as WASI & { setMemory(memory: WebAssembly.Memory): void }).setMemory(memory);
initialize();
const wasmResult = probe();
if (nativeResult !== EXPECTED_RESULT || wasmResult !== EXPECTED_RESULT) {
  throw new Error(`expected native and wasm results to be ${EXPECTED_RESULT}, got ${nativeResult} and ${wasmResult}`);
}

console.log(JSON.stringify({ nativeResult, wasmResult }));
