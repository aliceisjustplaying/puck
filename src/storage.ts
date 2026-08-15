import type { DeviceDescriptor, DeviceStorage, EmuExports } from "./wasm";

export type StorageMode = "interactive" | "throwaway";
export type InteractiveRestoreSource = "disk" | "staged";

export const STORAGE_ACCEPTED = 0;
export const STORAGE_EMPTY = 1;
export const STORAGE_INCOMPATIBLE = 2;
export const STORAGE_CORRUPT = 3;
const SAVE_DEBOUNCE_MS = 500;

export type StoragePresence =
  | { present: false }
  | { present: true; id: string; snapshotVersion: number; size: number; revision: number };

interface StagedStorage {
  id: string;
  snapshotVersion: number;
  maxBytes: number;
  bytes: Uint8Array;
  revision: number;
  generation: number;
}

interface ActiveStorage {
  identity: DeviceStorage;
  lastRevision: number;
}

export interface PreparedStorage {
  active: ActiveStorage | null;
  presence: StoragePresence;
}

function storageFunctions(emu: EmuExports) {
  const functions = [
    emu.emu_storage_buffer,
    emu.emu_storage_capacity,
    emu.emu_storage_size,
    emu.emu_storage_revision,
    emu.emu_storage_load,
  ];
  const present = functions.filter((fn) => fn !== undefined).length;
  if (present !== 0 && present !== functions.length) throw new Error("optional storage exports must be all present or all absent");
  return present === 0
    ? null
    : {
        buffer: emu.emu_storage_buffer!,
        capacity: emu.emu_storage_capacity!,
        size: emu.emu_storage_size!,
        revision: emu.emu_storage_revision!,
        load: emu.emu_storage_load!,
      };
}

function validateStorage(emu: EmuExports, device: DeviceDescriptor) {
  const functions = storageFunctions(emu);
  if ((device.storage !== undefined) !== (functions !== null)) {
    throw new Error(device.storage ? "descriptor declares storage but storage exports are missing" : "storage exports are present but descriptor storage is missing");
  }
  if (!device.storage || !functions) return null;
  const capacity = functions.capacity() >>> 0;
  const pointer = functions.buffer() >>> 0;
  if (capacity !== device.storage.maxBytes) {
    throw new Error(`storage capacity is ${capacity}, descriptor maxBytes is ${device.storage.maxBytes}`);
  }
  const memoryBytes = emu.memory.buffer.byteLength;
  if (pointer > memoryBytes || capacity > memoryBytes - pointer) {
    throw new Error(`storage buffer [${pointer}, ${pointer + capacity}) is outside memory (${memoryBytes} bytes)`);
  }
  return { functions, identity: device.storage, pointer, capacity };
}

function sameIdentity(a: { id: string; snapshotVersion: number }, b: { id: string; snapshotVersion: number }): boolean {
  return a.id === b.id && a.snapshotVersion === b.snapshotVersion;
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunk = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunk) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunk));
  }
  return btoa(binary);
}

function base64ToBytes(text: string): Uint8Array {
  const binary = atob(text);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

async function getStored(identity: DeviceStorage): Promise<StagedStorage | null> {
  const query = new URLSearchParams({ id: identity.id, snapshotVersion: String(identity.snapshotVersion) });
  const response = await fetch(`/api/storage?${query}`, { headers: { "x-puck-emulator": "1" } });
  if (response.status === 404) return null;
  if (!response.ok) throw new Error(`storage GET failed: HTTP ${response.status}: ${await response.text()}`);
  const stored = (await response.json()) as Omit<StagedStorage, "bytes"> & { blobBase64: string };
  const bytes = base64ToBytes(stored.blobBase64);
  if (!sameIdentity(stored, identity) || stored.maxBytes !== identity.maxBytes || bytes.length > identity.maxBytes) {
    throw new Error("stored snapshot metadata does not match the device descriptor");
  }
  return { ...stored, bytes };
}

export function loadEmptyStorage(emu: EmuExports, device: DeviceDescriptor): void {
  const validated = validateStorage(emu, device);
  if (!validated) return;
  const status = validated.functions.load(0);
  if (status !== STORAGE_EMPTY) throw new Error(`emu_storage_load(0) returned ${status}, expected ${STORAGE_EMPTY} (empty)`);
}

export class StorageHostCache {
  private staged: StagedStorage | null = null;
  private active: ActiveStorage | null = null;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private saving = false;
  private pendingSave = false;
  presence: StoragePresence = { present: false };

  async prepare(
    emu: EmuExports,
    device: DeviceDescriptor,
    mode: StorageMode,
    source: InteractiveRestoreSource,
    log: (text: string) => void,
  ): Promise<PreparedStorage> {
    const validated = validateStorage(emu, device);
    if (!validated) return { active: null, presence: { present: false } };

    if (mode === "throwaway") {
      const status = validated.functions.load(0);
      if (status !== STORAGE_EMPTY) throw new Error(`emu_storage_load(0) returned ${status}, expected ${STORAGE_EMPTY} (empty)`);
      return { active: null, presence: { present: false } };
    }

    let candidate: StagedStorage | null;
    if (source === "disk") {
      candidate = await getStored(validated.identity);
      if (candidate) this.staged = candidate;
    } else {
      candidate = this.staged && sameIdentity(this.staged, validated.identity) ? this.staged : null;
      if (this.staged && !candidate) log("storage: not restored because the live module changed persistence identity; started empty");
    }

    let status: number;
    if (candidate) {
      new Uint8Array(emu.memory.buffer, validated.pointer, candidate.bytes.length).set(candidate.bytes);
      status = validated.functions.load(candidate.bytes.length);
    } else {
      status = validated.functions.load(0);
    }

    if (status !== STORAGE_ACCEPTED && status !== STORAGE_EMPTY && status !== STORAGE_INCOMPATIBLE && status !== STORAGE_CORRUPT) {
      throw new Error(`emu_storage_load returned unknown status ${status}`);
    }
    if (status === STORAGE_INCOMPATIBLE || status === STORAGE_CORRUPT) {
      log(`storage: not restored (${status === STORAGE_INCOMPATIBLE ? "incompatible" : "corrupt"} snapshot); started empty`);
    }

    const revision = validated.functions.revision() >>> 0;
    const size = validated.functions.size() >>> 0;
    if (size > validated.capacity) throw new Error(`storage size ${size} exceeds capacity ${validated.capacity}`);
    const presence: StoragePresence = status === STORAGE_ACCEPTED
      ? { present: true, id: validated.identity.id, snapshotVersion: validated.identity.snapshotVersion, size, revision }
      : { present: false };
    return { active: { identity: validated.identity, lastRevision: revision }, presence };
  }

  activate(prepared: PreparedStorage): void {
    this.active = prepared.active;
    this.presence = prepared.presence;
  }

  poll(emu: EmuExports, device: DeviceDescriptor, log: (text: string) => void): void {
    if (!this.active || !device.storage || !sameIdentity(this.active.identity, device.storage)) return;
    const validated = validateStorage(emu, device);
    if (!validated) return;
    const revision = validated.functions.revision() >>> 0;
    if (revision === this.active.lastRevision) return;
    const size = validated.functions.size() >>> 0;
    if (size > validated.capacity) throw new Error(`storage size ${size} exceeds capacity ${validated.capacity}`);
    const bytes = new Uint8Array(size);
    bytes.set(new Uint8Array(emu.memory.buffer, validated.pointer, size));
    const generation = this.staged && sameIdentity(this.staged, device.storage) ? this.staged.generation : 0;
    this.staged = { ...device.storage, bytes, revision, generation };
    this.pendingSave = true;
    this.active.lastRevision = revision;
    this.presence = { present: true, id: device.storage.id, snapshotVersion: device.storage.snapshotVersion, size, revision };
    this.scheduleSave(log);
  }

  private scheduleSave(log: (text: string) => void): void {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      void this.save(log);
    }, SAVE_DEBOUNCE_MS);
  }

  private async save(log: (text: string) => void, keepalive = false): Promise<void> {
    const staged = this.staged;
    if (!staged || !this.pendingSave || this.saving) return;
    this.saving = true;
    try {
      const response = await fetch("/api/storage", {
        method: "PUT",
        headers: { "content-type": "application/json", "x-puck-emulator": "1" },
        keepalive,
        body: JSON.stringify({
          id: staged.id,
          snapshotVersion: staged.snapshotVersion,
          maxBytes: staged.maxBytes,
          size: staged.bytes.length,
          revision: staged.revision,
          expectedGeneration: staged.generation,
          blobBase64: bytesToBase64(staged.bytes),
        }),
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}: ${await response.text()}`);
      const result = (await response.json()) as { generation: number; concurrent: boolean };
      if (this.staged === staged) {
        this.staged.generation = result.generation;
        this.pendingSave = false;
      }
      if (result.concurrent) log("storage: another tab wrote this snapshot; last writer wins and concurrent tabs are unsupported");
    } catch (error) {
      log(`storage save failed: ${error instanceof Error ? error.message : String(error)}`);
    } finally {
      this.saving = false;
      if (this.pendingSave && this.staged !== staged) this.scheduleSave(log);
    }
  }

  pageHide(log: (text: string) => void): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    void this.save(log, true);
  }
}
