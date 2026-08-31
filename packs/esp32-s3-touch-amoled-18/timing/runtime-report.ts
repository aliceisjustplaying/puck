#!/usr/bin/env bun

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressMapConfiguration, AddressRegion } from "./address-map";
import {
  ESP32_S3_CACHE_BANK_TOPOLOGY,
  type CacheConfiguration,
  type CacheLatency,
} from "./cache";
import { parseTimingProfile, type TimingProfileV1 } from "./consumer";
import { runRuntimeTimingTrace, runtimeTimingResultJson } from "./runtime-trace";
import {
  adaptNeutralTimingTrace,
  type BoundedNeutralTrace,
  type NeutralTraceObservation,
} from "./trace-adapter";

const FORMAT = "puck-esp32s3-runtime-trace-v1";
const PROFILE_SOURCE = "packs/esp32-s3-touch-amoled-18/timing.json";
const MAX_TRACE_RECORDS = 65_536;
const MAX_SRAM_REGIONS = 64;

type JsonObject = Record<string, unknown>;

function objectAt(value: unknown, path: string): JsonObject {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`${path} must be an object`);
  }
  return value as JsonObject;
}

function exactKeys(value: JsonObject, expected: readonly string[], path: string): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (JSON.stringify(actual) !== JSON.stringify(wanted)) {
    throw new Error(`${path} keys must be exactly ${wanted.join(", ")}; got ${actual.join(", ")}`);
  }
}

function nonEmptyString(value: unknown, path: string): string {
  if (typeof value !== "string" || value.length === 0) throw new Error(`${path} must be a non-empty string`);
  return value;
}

function safeInteger(value: unknown, path: string, minimum = 0): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum) {
    throw new Error(`${path} must be a safe integer at least ${minimum}`);
  }
  return value as number;
}

function booleanAt(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw new Error(`${path} must be boolean`);
  return value;
}

function uint32Address(value: unknown, path: string): bigint {
  if (typeof value !== "string" || !/^0x(?:0|[1-9a-f][0-9a-f]*)$/.test(value)) {
    throw new Error(`${path} must be a canonical lowercase hexadecimal address`);
  }
  const address = BigInt(value);
  if (address > 0xffff_ffffn) throw new Error(`${path} must fit the 32-bit address space`);
  return address;
}

function knownCost(cycles: number, component: string, profile: TimingProfileV1, profileSource: string): CacheLatency {
  return Object.freeze({
    status: "known",
    cycles: BigInt(cycles),
    calibration: "calibrated",
    source: `${profileSource}; evidence ${profile.coreSteadyStateCycles.evidence}; ${component}`,
  });
}

function unknownCost(component: string, profileSource: string): CacheLatency {
  return Object.freeze({
    status: "unknown",
    reason: `${component} has no adopted cost in this bounded runtime replay`,
    source: profileSource,
  });
}

function parseRegions(value: unknown): readonly AddressRegion[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SRAM_REGIONS) {
    throw new Error(`runtime trace internalSramRegions must contain 1 to ${MAX_SRAM_REGIONS} exact regions`);
  }
  return Object.freeze(value.map((entry, index) => {
    const path = `runtime trace internalSramRegions[${index}]`;
    const region = objectAt(entry, path);
    exactKeys(region, ["id", "base", "sizeBytes", "permissions"], path);
    const id = nonEmptyString(region.id, `${path}.id`);
    const base = uint32Address(region.base, `${path}.base`);
    const sizeBytes = safeInteger(region.sizeBytes, `${path}.sizeBytes`, 1);
    if (base + BigInt(sizeBytes) > 0x1_0000_0000n) {
      throw new Error(`${path} must fit the 32-bit address space`);
    }
    const permissions = objectAt(region.permissions, `${path}.permissions`);
    exactKeys(permissions, ["read", "write", "execute"], `${path}.permissions`);
    return Object.freeze({
      id,
      base,
      size: BigInt(sizeBytes),
      kind: "sram" as const,
      permissions: Object.freeze({
        read: booleanAt(permissions.read, `${path}.permissions.read`),
        write: booleanAt(permissions.write, `${path}.permissions.write`),
        execute: booleanAt(permissions.execute, `${path}.permissions.execute`),
      }),
      cacheability: "uncached" as const,
      physical: Object.freeze({ backingId: `runtime-trace:${id}`, offset: 0n }),
    });
  }));
}

function parseObservations(
  value: unknown,
  instructionCpuCost: CacheLatency,
): readonly NeutralTraceObservation[] {
  if (!Array.isArray(value)) throw new Error("runtime trace observations must be an array");
  if (value.length > MAX_TRACE_RECORDS) {
    throw new Error(`runtime trace observations must not exceed ${MAX_TRACE_RECORDS} records`);
  }
  return Object.freeze(value.map((entry, index) => {
    const path = `runtime trace observations[${index}]`;
    const observation = objectAt(entry, path);
    exactKeys(observation, ["id", "sequence", "core", "kind", "address", "width"], path);
    const core = safeInteger(observation.core, `${path}.core`);
    if (core !== 0 && core !== 1) throw new Error(`${path}.core must be 0 or 1`);
    const kind = observation.kind;
    if (kind !== "instruction" && kind !== "read" && kind !== "write") {
      throw new Error(`${path}.kind must be instruction, read, or write`);
    }
    return Object.freeze({
      id: nonEmptyString(observation.id, `${path}.id`),
      sequence: safeInteger(observation.sequence, `${path}.sequence`),
      core,
      kind,
      address: uint32Address(observation.address, `${path}.address`),
      width: safeInteger(observation.width, `${path}.width`, 1),
      ...(kind === "instruction" ? { cpuCost: instructionCpuCost } : {}),
    });
  }));
}

function replayArtifact(rawBytes: Uint8Array, profile: TimingProfileV1, profileSource: string): string {
  const artifact = objectAt(JSON.parse(new TextDecoder().decode(rawBytes)), "runtime trace");
  exactKeys(
    artifact,
    ["schemaVersion", "format", "source", "capacity", "overflow", "internalSramRegions", "observations"],
    "runtime trace",
  );
  if (artifact.schemaVersion !== 1) throw new Error("runtime trace schemaVersion must be 1");
  if (artifact.format !== FORMAT) throw new Error(`runtime trace format must be ${FORMAT}`);
  const source = nonEmptyString(artifact.source, "runtime trace source");
  const capacity = safeInteger(artifact.capacity, "runtime trace capacity");
  if (capacity > MAX_TRACE_RECORDS) {
    throw new Error(`runtime trace capacity must not exceed ${MAX_TRACE_RECORDS}`);
  }
  const digest = createHash("sha256").update(rawBytes).digest("hex");
  const instructionCpuCost = knownCost(
    profile.coreSteadyStateCycles.instructionIssueCycles,
    "steady-state instruction issue",
    profile,
    profileSource,
  );
  const regions = parseRegions(artifact.internalSramRegions);
  const neutral: BoundedNeutralTrace = Object.freeze({
    schemaVersion: 1,
    capacity,
    overflow: booleanAt(artifact.overflow, "runtime trace overflow"),
    provenance: Object.freeze({
      source,
      format: FORMAT,
      digest: Object.freeze({ algorithm: "sha256" as const, value: digest }),
    }),
    observations: parseObservations(artifact.observations, instructionCpuCost),
  });
  const addressMap: AddressMapConfiguration = Object.freeze({
    addressBits: 32,
    metadata: Object.freeze({
      architectureCalibration: "uncalibrated",
      source: `${source}; exact caller-declared internal SRAM regions`,
    }),
    regions,
  });
  const unknown = unknownCost("unused cache path", profileSource);
  const cache: CacheConfiguration = Object.freeze({
    addressBits: 32,
    metadata: Object.freeze({
      architectureCalibration: "uncalibrated",
      source: "ESP32-S3 cache geometry is inactive for this SRAM-only runtime replay",
    }),
    topology: ESP32_S3_CACHE_BANK_TOPOLOGY,
    instruction: Object.freeze({
      lineSizeBytes: 32,
      sets: 64,
      ways: 8,
      replacement: "least-recently-used",
      writePolicy: "read-only",
    }),
    data: Object.freeze({
      lineSizeBytes: 64,
      sets: 64,
      ways: 8,
      replacement: "least-recently-used",
      writePolicy: "write-back",
      allocateOnStoreMiss: true,
      dirtyInvalidate: "writeback",
    }),
    costs: Object.freeze({
      hit: Object.freeze({ instructionFetch: unknown, load: unknown, store: unknown }),
      lineFill: unknown,
      dirtyWriteback: unknown,
      writeThrough: unknown,
      uncached: Object.freeze({ instructionFetch: unknown, load: unknown, store: unknown }),
      sram: Object.freeze({
        instructionFetch: knownCost(
          profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.instructionFetch,
          "internal SRAM instruction-fetch additive cost",
          profile,
          profileSource,
        ),
        load: knownCost(
          profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.load,
          "independent internal SRAM load additive cost",
          profile,
          profileSource,
        ),
        store: knownCost(
          profile.coreSteadyStateCycles.independentSramAccessAdditiveCycles.store,
          "independent internal SRAM store additive cost",
          profile,
          profileSource,
        ),
      }),
      maintenance: unknown,
    }),
  });
  const trace = adaptNeutralTimingTrace(neutral);
  return runtimeTimingResultJson(runRuntimeTimingTrace({
    addressMap,
    cache,
    mmioCost: () => unknownCost("MMIO access", profileSource),
  }, trace));
}

export async function runRuntimeTimingReport(tracePath: string): Promise<string> {
  const resolvedTracePath = resolve(nonEmptyString(tracePath, "runtime trace path"));
  const profilePath = join(import.meta.dir, "..", "timing.json");
  const profile = parseTimingProfile(JSON.parse(readFileSync(profilePath, "utf8")));
  return replayArtifact(
    new Uint8Array(readFileSync(resolvedTracePath)),
    profile,
    `timing profile ${PROFILE_SOURCE}`,
  );
}

function usage(): never {
  console.error(`usage: bun packs/esp32-s3-touch-amoled-18/timing/runtime-report.ts <${FORMAT}.json>`);
  process.exit(2);
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) usage();
    process.stdout.write(await runRuntimeTimingReport(process.argv[2]!));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
