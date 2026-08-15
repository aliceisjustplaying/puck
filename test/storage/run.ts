#!/usr/bin/env bun
import { buildStorageFixture } from "./build";
import { instantiate, readDeviceDescriptor, type EmuExports } from "../../src/wasm";
import { StorageHostCache } from "../../src/storage";
import { Recorder, validateTrace, type TraceV2, type TraceV3 } from "../../src/recorder";
import { Replayer } from "../../src/replay";
import { replayFromBytes } from "../../src/replayCore";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const wasmPath = buildStorageFixture();
const bytes = await Bun.file(wasmPath).arrayBuffer();

async function fresh(): Promise<{ emu: EmuExports; device: ReturnType<typeof readDeviceDescriptor> }> {
  const emu = await instantiate(bytes, () => {});
  assert(emu.emu_init() === 1, "fixture emu_init failed");
  return { emu, device: readDeviceDescriptor(emu) };
}

function framebuffer(emu: EmuExports): Uint16Array {
  return new Uint16Array(emu.memory.buffer, emu.emu_fb(), 4);
}

const hostStore: { request: Record<string, unknown> | null; generation: number } = { request: null, generation: 0 };
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
  if (init?.method === "PUT") {
    hostStore.request = JSON.parse(String(init.body)) as Record<string, unknown>;
    hostStore.generation++;
    return Response.json({ generation: hostStore.generation, concurrent: false });
  }
  if (!hostStore.request) return new Response("no stored snapshot", { status: 404 });
  return Response.json({ ...hostStore.request, generation: hostStore.generation });
}) as typeof fetch;

try {
  const logs: string[] = [];
  const first = await fresh();
  const cache = new StorageHostCache();
  const initial = await cache.prepare(first.emu, first.device, "interactive", "disk", (text) => logs.push(text));
  cache.activate(initial);
  assert(!initial.presence.present, "empty first load unexpectedly restored storage");

  first.emu.emu_button(0, 1);
  first.emu.emu_tick(1);
  cache.poll(first.emu, first.device, (text) => logs.push(text));
  assert(framebuffer(first.emu)[0] === 11, "fixture did not mutate durable state");
  await Bun.sleep(650);
  assert(hostStore.request?.size === 7, "500 ms debounced save did not reach the host store");

  const stagedReload = await fresh();
  const stagedPrepared = await cache.prepare(stagedReload.emu, stagedReload.device, "interactive", "staged", (text) => logs.push(text));
  cache.activate(stagedPrepared);
  assert(stagedPrepared.presence.present && framebuffer(stagedReload.emu)[0] === 11, "live reload did not restore the staged copy");

  const pageReload = await fresh();
  const pageCache = new StorageHostCache();
  const diskPrepared = await pageCache.prepare(pageReload.emu, pageReload.device, "interactive", "disk", (text) => logs.push(text));
  pageCache.activate(diskPrepared);
  assert(diskPrepared.presence.present && framebuffer(pageReload.emu)[0] === 11, "page reload did not restore the disk copy");
  const generationBeforeHide = hostStore.generation;
  pageCache.pageHide((text) => logs.push(text));
  await Bun.sleep(20);
  assert(hostStore.generation === generationBeforeHide, "pagehide rewrote an unchanged disk snapshot");
  pageReload.emu.emu_button(0, 1);
  pageReload.emu.emu_tick(2);
  pageCache.poll(pageReload.emu, pageReload.device, (text) => logs.push(text));
  pageCache.pageHide((text) => logs.push(text));
  await Bun.sleep(20);
  assert(hostStore.generation === generationBeforeHide + 1, "pagehide did not attempt the newest staged save");

  const replay = await replayFromBytes(bytes, 2, [{ t: 0, k: "tick" }], [0]);
  assert(replay.frames.length === 1, "isolated replay did not capture a frame");
  const expectedBlue = Math.round((10 / 31) * 255);
  assert(replay.frames[0]!.frame.rgb[2] === expectedBlue, "replay inherited the interactive storage cache");

  const statusGuest = await fresh();
  const transfer = new Uint8Array(statusGuest.emu.memory.buffer, statusGuest.emu.emu_storage_buffer!(), 16);
  assert(statusGuest.emu.emu_storage_load!(0) === 1, "empty storage status is unreachable");

  transfer.set([80, 85, 75, 49, 2, 99, 0]);
  transfer[6] = transfer[0]! ^ transfer[1]! ^ transfer[2]! ^ transfer[3]! ^ transfer[4]! ^ transfer[5]!;
  assert(statusGuest.emu.emu_storage_load!(7) === 2, "incompatible storage status is unreachable");
  assert(framebuffer(statusGuest.emu)[0] === 10, "incompatible load partially mutated durable state");

  transfer.set([0, 85, 75, 49, 1, 99, 0]);
  assert(statusGuest.emu.emu_storage_load!(7) === 3, "corrupt storage status is unreachable");
  assert(framebuffer(statusGuest.emu)[0] === 10, "corrupt load partially mutated durable state");

  transfer.set([80, 85, 75, 49, 1, 77, 0]);
  transfer[6] = transfer[0]! ^ transfer[1]! ^ transfer[2]! ^ transfer[3]! ^ transfer[4]! ^ transfer[5]!;
  assert(statusGuest.emu.emu_storage_load!(7) === 0, "accepted storage status is unreachable");
  assert(framebuffer(statusGuest.emu)[0] === 77, "accepted storage did not restore durable state");

  const batteryGuest = await fresh();
  batteryGuest.emu.emu_battery!(74, 1, 1);
  assert(framebuffer(batteryGuest.emu)[1] === 0, "battery input mutated before the tick");
  batteryGuest.emu.emu_tick(2);
  assert(framebuffer(batteryGuest.emu)[1] === 843, "battery input was not consumed on the tick");

  const recorder = new Recorder();
  recorder.record({ t: 2, k: "battery", percent: 74, charging: 1, external: 1 });
  recorder.record({ t: 2, k: "tick" });
  const trace = recorder.toTrace(batteryGuest.device);
  assert(trace.schemaVersion === 3 && trace.events[0]?.k === "battery", "recorder did not emit a schema-3 battery event");

  const replayBatteryGuest = await fresh();
  const replayer = new Replayer(trace);
  assert(replayer.stepFrame(replayBatteryGuest.emu) === 2, "battery trace did not replay through its tick");
  assert(framebuffer(replayBatteryGuest.emu)[1] === 843, "battery replay did not reproduce the latched state");

  const schema2: TraceV2 = {
    schemaVersion: 2,
    recordedAt: new Date(0).toISOString(),
    device: batteryGuest.device,
    truncated: false,
    events: [{ t: 0, k: "tick" }],
  };
  validateTrace(schema2);
  const invalidSchema2 = { ...schema2, events: [{ t: 0, k: "battery", percent: 50, charging: 0, external: 0 }] } as unknown as TraceV3;
  let rejected = false;
  try { validateTrace(invalidSchema2); } catch { rejected = true; }
  assert(rejected, "schema 2 accepted a battery event");

  console.log("storage and battery contract: PASS");
} finally {
  globalThis.fetch = originalFetch;
}
