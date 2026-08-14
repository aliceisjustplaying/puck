import { join } from "node:path";
import { instantiate, readDeviceDescriptor } from "../../src/wasm";
import {
  MEMORY_EXPORT_NAME,
  REQUIRED_EMU_EXPORT_NAMES,
  WASI_INITIALIZE_EXPORT_NAME,
  WASI_PREVIEW1_IMPORT_NAMES,
} from "../../src/abiSurface";

const wasmPath = join(import.meta.dir, "dist", "cxx_reactor.wasm");

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function freshInstance() {
  const bytes = await Bun.file(wasmPath).arrayBuffer();
  const logs: string[] = [];
  const emu = await instantiate(bytes, (text) => logs.push(text));
  assert(emu.emu_init() === 1, "emu_init failed");
  return { emu, logs };
}

await import("./build");

const builtBytes = await Bun.file(wasmPath).arrayBuffer();
const builtModule = await WebAssembly.compile(builtBytes);
const imports = WebAssembly.Module.imports(builtModule)
  .map(({ module, name }) => `${module}.${name}`)
  .sort();
const expectedImports = WASI_PREVIEW1_IMPORT_NAMES
  .filter((name) => name !== "proc_exit")
  .map((name) => `wasi_snapshot_preview1.${name}`)
  .sort();
assert(JSON.stringify(imports) === JSON.stringify(expectedImports), `unexpected imports: ${imports.join(", ")}`);
const actualExports = WebAssembly.Module.exports(builtModule)
  .map(({ name, kind }) => `${kind}:${name}`)
  .sort();
const expectedExports = [
  `function:${WASI_INITIALIZE_EXPORT_NAME}`,
  ...REQUIRED_EMU_EXPORT_NAMES.map((name) => `function:${name}`),
  `memory:${MEMORY_EXPORT_NAME}`,
].sort();
assert(
  JSON.stringify(actualExports) === JSON.stringify(expectedExports),
  `unexpected exports: ${actualExports.join(", ")}`,
);

const first = await freshInstance();
assert(first.logs.includes("cxx reactor ready"), "WASI stderr was not routed to the firmware log");
const descriptor = readDeviceDescriptor(first.emu);
assert(descriptor.name === "cxx-reactor", "wrong descriptor name");
assert(descriptor.panel.w === 4 && descriptor.panel.h === 4, "wrong panel dimensions");
assert(descriptor.panel.format === "rgb565", "wrong framebuffer format");

const framebuffer = () =>
  new Uint16Array(first.emu.memory.buffer, first.emu.emu_fb(), descriptor.panel.w * descriptor.panel.h);
const before = framebuffer()[6];
first.emu.emu_touch(1, 2, 1);
assert(framebuffer()[6] === before, "emu_touch mutated before emu_tick");
first.emu.emu_tick(3);
assert(framebuffer()[6] === 0x001f, "C++ vector-backed framebuffer did not update");
assert(first.emu.emu_push_count() === 1, "expected one push");

const second = await freshInstance();
const secondDescriptor = readDeviceDescriptor(second.emu);
const secondFramebuffer = new Uint16Array(
  second.emu.memory.buffer,
  second.emu.emu_fb(),
  secondDescriptor.panel.w * secondDescriptor.panel.h,
);
assert(secondFramebuffer[6] === 0xffff, "fresh reactor instance retained prior state");

console.log("C++20 WASI reactor: PASS");
