#!/usr/bin/env bun

import { instantiate, readDeviceDescriptor, readFramebufferPointer } from "../src/wasm";
import { MAX_PUSHES_PER_TICK, validatePushCount, validatePushRect } from "../src/abiGuard";
import { pixelReaderFor } from "../src/panel";
import {
  ENV_IMPORT_NAMES,
  MEMORY_EXPORT_NAME,
  OPTIONAL_APP_EXPORT_NAMES,
  OPTIONAL_BATTERY_EXPORT_NAMES,
  OPTIONAL_SOUND_EXPORT_NAMES,
  OPTIONAL_STORAGE_EXPORT_NAMES,
  REQUIRED_EMU_EXPORT_NAMES,
  WASI_INITIALIZE_EXPORT_NAME,
  WASI_PREVIEW1_IMPORT_NAMES,
} from "../src/abiSurface";

interface Options {
  wasmPath: string;
  width?: number;
  height?: number;
  format?: "rgb565" | "rgb565be";
  initialMemory?: number;
  maxMemory?: number;
  allowExports: string[];
}

const ALLOWED_IMPORTS = new Set([
  ...ENV_IMPORT_NAMES.map((name) => `env.${name}`),
  ...WASI_PREVIEW1_IMPORT_NAMES.map((name) => `wasi_snapshot_preview1.${name}`),
]);

class ExceededExpectedMaximum extends Error {
  constructor(bytes: number) {
    super(`memory can grow beyond the expected maximum of ${bytes} bytes`);
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function positiveInteger(value: string | undefined, flag: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) fail(`${flag} must be a positive integer`);
  return parsed;
}

function parseOptions(args: string[]): Options {
  if (args.length === 0 || args[0]!.startsWith("--")) {
    fail("usage: bun run audit path/to/emu.wasm [--width N --height N --format rgb565|rgb565be --initial-memory N --max-memory N --allow-exports name,name]");
  }
  const options: Options = { wasmPath: args[0]!, allowExports: [] };
  const seen = new Set<string>();
  for (let index = 1; index < args.length; index += 2) {
    const flag = args[index];
    const value = args[index + 1];
    if (!flag?.startsWith("--") || value === undefined) fail(`invalid arguments: ${args.slice(1).join(" ")}`);
    if (seen.has(flag)) fail(`duplicate option ${flag}`);
    seen.add(flag);
    switch (flag) {
      case "--width":
        options.width = positiveInteger(value, flag);
        break;
      case "--height":
        options.height = positiveInteger(value, flag);
        break;
      case "--format":
        if (value !== "rgb565" && value !== "rgb565be") fail(`${flag} must be rgb565 or rgb565be`);
        options.format = value;
        break;
      case "--initial-memory":
        options.initialMemory = positiveInteger(value, flag);
        break;
      case "--max-memory":
        options.maxMemory = positiveInteger(value, flag);
        break;
      case "--allow-exports":
        // Firmware-local extensions beyond the documented ABI (a debug or
        // tuning surface, say) fail the audit unless named here, on purpose:
        // an extra export should be a conscious, visible decision, never a
        // silent pass. Comma-separated function names.
        options.allowExports = value.split(",").map((name) => name.trim()).filter((name) => name.length > 0);
        if (options.allowExports.length === 0) fail(`${flag} needs at least one export name`);
        break;
      default:
        fail(`unknown option ${flag}`);
    }
  }
  for (const [flag, value] of [
    ["--initial-memory", options.initialMemory],
    ["--max-memory", options.maxMemory],
  ] as const) {
    if (value !== undefined && value % 65_536 !== 0) {
      fail(`${flag} must be a multiple of one WebAssembly page (65536 bytes)`);
    }
  }
  if (options.initialMemory !== undefined && options.maxMemory !== undefined && options.maxMemory < options.initialMemory) {
    fail("--max-memory must not be smaller than --initial-memory");
  }
  return options;
}

function requireWholeGroup(exports: Map<string, WebAssembly.ImportExportKind>, names: readonly string[], label: string): void {
  const present = names.filter((name) => exports.has(name));
  if (present.length !== 0 && present.length !== names.length) {
    fail(`${label} exports must be all present or all absent, found: ${present.join(", ")}`);
  }
}

async function audit(options: Options): Promise<string> {
  const bytes = await Bun.file(options.wasmPath).arrayBuffer();
  const module = await WebAssembly.compile(bytes);
  const moduleImports = WebAssembly.Module.imports(module);

  for (const entry of moduleImports) {
    const name = `${entry.module}.${entry.name}`;
    if (entry.kind !== "function") fail(`import ${name} has unsupported kind ${entry.kind}`);
    if (!ALLOWED_IMPORTS.has(name)) fail(`unknown import ${name}`);
  }

  const exports = new Map(WebAssembly.Module.exports(module).map((entry) => [entry.name, entry.kind]));
  const allowedExports = new Set<string>([
    MEMORY_EXPORT_NAME,
    WASI_INITIALIZE_EXPORT_NAME,
    ...REQUIRED_EMU_EXPORT_NAMES,
    ...OPTIONAL_APP_EXPORT_NAMES,
    ...OPTIONAL_BATTERY_EXPORT_NAMES,
    ...OPTIONAL_SOUND_EXPORT_NAMES,
    ...OPTIONAL_STORAGE_EXPORT_NAMES,
    ...options.allowExports,
  ]);
  for (const [name, kind] of exports) {
    if (!allowedExports.has(name)) fail(`unknown export ${name}`);
    const expectedKind = name === MEMORY_EXPORT_NAME ? "memory" : "function";
    if (kind !== expectedKind) fail(`export ${name} has kind ${kind}, expected ${expectedKind}`);
  }
  if (exports.get(MEMORY_EXPORT_NAME) !== "memory") fail("required memory export is missing");
  for (const name of REQUIRED_EMU_EXPORT_NAMES) {
    if (exports.get(name) !== "function") fail(`required function export ${name} is missing`);
  }
  const usesWasi = moduleImports.some((entry) => entry.module === "wasi_snapshot_preview1");
  if (usesWasi && exports.get(WASI_INITIALIZE_EXPORT_NAME) !== "function") {
    fail("a module importing wasi_snapshot_preview1 must export _initialize as required by ADR 0004");
  }
  requireWholeGroup(exports, OPTIONAL_APP_EXPORT_NAMES, "optional app");
  requireWholeGroup(exports, OPTIONAL_SOUND_EXPORT_NAMES, "optional sound");
  requireWholeGroup(exports, OPTIONAL_STORAGE_EXPORT_NAMES, "optional storage");
  requireWholeGroup(exports, OPTIONAL_BATTERY_EXPORT_NAMES, "optional battery");

  const logs: string[] = [];
  const emu = await instantiate(bytes, (text) => logs.push(text));
  if (emu.emu_init() === 0) fail(`emu_init returned failure${logs.length > 0 ? `: ${logs.join(" | ")}` : ""}`);
  const descriptor = readDeviceDescriptor(emu);
  const declaresApps = descriptor.apps !== undefined;
  const exportsApps = OPTIONAL_APP_EXPORT_NAMES.every((name) => exports.get(name) === "function");
  if (declaresApps !== exportsApps) {
    fail(
      declaresApps
        ? "descriptor declares an apps array but the optional app export pair is missing"
        : "optional app exports are present but the descriptor does not declare an apps array",
    );
  }

  const declaresStorage = descriptor.storage !== undefined;
  const exportsStorage = OPTIONAL_STORAGE_EXPORT_NAMES.every((name) => exports.get(name) === "function");
  if (declaresStorage !== exportsStorage) {
    fail(
      declaresStorage
        ? "descriptor declares storage but the optional storage export group is missing"
        : "optional storage exports are present but the descriptor does not declare storage",
    );
  }
  if (declaresStorage) {
    const storage = descriptor.storage!;
    const capacity = emu.emu_storage_capacity!() >>> 0;
    const pointer = emu.emu_storage_buffer!() >>> 0;
    const size = emu.emu_storage_size!() >>> 0;
    if (capacity !== storage.maxBytes) fail(`storage capacity is ${capacity}, descriptor maxBytes is ${storage.maxBytes}`);
    if (size > capacity) fail(`storage size ${size} exceeds capacity ${capacity}`);
    if (pointer > emu.memory.buffer.byteLength || capacity > emu.memory.buffer.byteLength - pointer) {
      fail(`storage buffer [${pointer}, ${pointer + capacity}) is outside memory (${emu.memory.buffer.byteLength} bytes)`);
    }
    emu.emu_storage_revision!();
    const emptyStatus = emu.emu_storage_load!(0);
    if (emptyStatus !== 1) fail(`emu_storage_load(0) returned ${emptyStatus}, expected 1 (empty)`);
  }

  const declaresBattery = descriptor.battery === true;
  const exportsBattery = OPTIONAL_BATTERY_EXPORT_NAMES.every((name) => exports.get(name) === "function");
  if (declaresBattery !== exportsBattery) {
    fail(
      declaresBattery
        ? "descriptor declares battery but emu_battery is missing"
        : "emu_battery is exported but the descriptor does not declare battery",
    );
  }
  pixelReaderFor(descriptor.panel.format);
  if (options.width !== undefined && descriptor.panel.w !== options.width) {
    fail(`descriptor width is ${descriptor.panel.w}, expected ${options.width}`);
  }
  if (options.height !== undefined && descriptor.panel.h !== options.height) {
    fail(`descriptor height is ${descriptor.panel.h}, expected ${options.height}`);
  }
  if (options.format !== undefined && descriptor.panel.format !== options.format) {
    fail(`descriptor format is ${JSON.stringify(descriptor.panel.format)}, expected ${JSON.stringify(options.format)}`);
  }
  readFramebufferPointer(emu, descriptor.panel);

  const initialBytes = emu.memory.buffer.byteLength;
  if (options.initialMemory !== undefined && initialBytes !== options.initialMemory) {
    fail(`initial memory is ${initialBytes} bytes, expected ${options.initialMemory}`);
  }

  emu.emu_tick(0);
  const rawPushCount = emu.emu_push_count();
  const pushCount = validatePushCount(rawPushCount);
  if (pushCount.reason || pushCount.count > MAX_PUSHES_PER_TICK) {
    fail(pushCount.reason ?? `refresh count exceeds ${MAX_PUSHES_PER_TICK}`);
  }
  for (let index = 0; index < pushCount.count; index++) {
    const rect = {
      x: emu.emu_push_x(index),
      y: emu.emu_push_y(index),
      w: emu.emu_push_w(index),
      h: emu.emu_push_h(index),
    };
    const validation = validatePushRect(rect, descriptor.panel.w, descriptor.panel.h);
    if (!validation.ok) fail(`invalid refresh rectangle at index ${index}: ${validation.reason}`);
  }

  if (options.maxMemory !== undefined) {
    const currentPages = emu.memory.buffer.byteLength / 65_536;
    const maxPages = options.maxMemory / 65_536;
    if (currentPages > maxPages) fail(`current memory exceeds expected maximum of ${options.maxMemory} bytes`);
    try {
      emu.memory.grow(maxPages - currentPages);
    } catch {
      fail(`memory cannot grow to the expected maximum of ${options.maxMemory} bytes`);
    }
    try {
      emu.memory.grow(1);
      throw new ExceededExpectedMaximum(options.maxMemory);
    } catch (error) {
      if (error instanceof ExceededExpectedMaximum) throw error;
    }
  }

  return `Puck ABI audit: PASS (${descriptor.panel.w}x${descriptor.panel.h} ${descriptor.panel.format}, ${bytes.byteLength} bytes)`;
}

try {
  console.log(await audit(parseOptions(process.argv.slice(2))));
  process.exit(0);
} catch (error) {
  console.error(`Puck ABI audit: FAIL (${error instanceof Error ? error.message : String(error)})`);
  process.exit(1);
}
