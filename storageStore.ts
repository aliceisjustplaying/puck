import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const STORAGE_DIR = join(import.meta.dir, "storage");

export interface StorageRecord {
  id: string;
  snapshotVersion: number;
  maxBytes: number;
  size: number;
  revision: number;
  generation: number;
  blobBase64: string;
}

export interface StorageWrite extends Omit<StorageRecord, "generation"> {
  expectedGeneration: number;
}

function key(id: string, snapshotVersion: number): string {
  return createHash("sha256").update(`${id}\0${snapshotVersion}`).digest("hex");
}

function recordPath(id: string, snapshotVersion: number): string {
  return join(STORAGE_DIR, `${key(id, snapshotVersion)}.json`);
}

export function loadStorage(id: string, snapshotVersion: number): StorageRecord | null {
  const path = recordPath(id, snapshotVersion);
  if (!existsSync(path)) return null;
  const record = JSON.parse(readFileSync(path, "utf8")) as StorageRecord;
  if (record.id !== id || record.snapshotVersion !== snapshotVersion) throw new Error("storage record identity does not match its key");
  return record;
}

export function saveStorage(input: StorageWrite): { record: StorageRecord; concurrent: boolean } {
  const previous = loadStorage(input.id, input.snapshotVersion);
  const previousGeneration = previous?.generation ?? 0;
  const concurrent = input.expectedGeneration !== previousGeneration;
  const bytes = Buffer.from(input.blobBase64, "base64");
  if (input.size !== bytes.length) throw new Error(`storage size ${input.size} does not match decoded blob size ${bytes.length}`);
  if (input.size > input.maxBytes) throw new Error(`storage size ${input.size} exceeds maxBytes ${input.maxBytes}`);
  const record: StorageRecord = {
    id: input.id,
    snapshotVersion: input.snapshotVersion,
    maxBytes: input.maxBytes,
    size: input.size,
    revision: input.revision,
    generation: previousGeneration + 1,
    blobBase64: input.blobBase64,
  };
  mkdirSync(STORAGE_DIR, { recursive: true });
  const path = recordPath(input.id, input.snapshotVersion);
  const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(temporary, JSON.stringify(record));
  renameSync(temporary, path);
  return { record, concurrent };
}
