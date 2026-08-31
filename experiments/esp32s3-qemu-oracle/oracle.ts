import { readFileSync } from "node:fs";
import {
  DEFAULT_CORPUS_PATH,
  DEFAULT_FIXTURE_OBSERVATION_PATH,
  ESP32S3_QEMU_MACHINE,
  ESPRESSIF_QEMU_COMMIT,
  ESPRESSIF_QEMU_LICENSE,
  ESPRESSIF_QEMU_REPOSITORY,
  FLEXE_COMMIT,
  FLEXE_REPOSITORY,
  QEMU_ORACLE_CORPUS_SCHEMA,
  QEMU_ORACLE_OBSERVATION_SCHEMA,
  QEMU_ORACLE_TERMINATION,
  REGISTER_NAMES,
  type RegisterName,
} from "./constants";

const REGISTER_NAME_SET = new Set<string>(REGISTER_NAMES);

export interface OracleTraceStep {
  pc: number;
  width: 2 | 3 | 4;
  instructionBytesHex: string;
}

export interface OracleObservedMemory {
  address: number;
  bytesHex: string;
}

export interface OracleObservationCase {
  id: string;
  termination: typeof QEMU_ORACLE_TERMINATION;
  finalPc: number;
  steps: number;
  registers: Partial<Record<RegisterName, number>>;
  memory: OracleObservedMemory[];
  trace: OracleTraceStep[];
}

export interface OracleCorpusCase extends OracleObservationCase {
  description: string;
  pc: number;
  instructionBudget: number;
  codeBytesHex: string;
  initialRegisters: Partial<Record<RegisterName, number>>;
  initialMemory: OracleObservedMemory[];
  observeRegisters: RegisterName[];
  observeMemory: { address: number; length: number }[];
}

export interface OracleCorpus {
  schema: typeof QEMU_ORACLE_CORPUS_SCHEMA;
  provenance: {
    flexeRepository: string;
    flexeCommit: string;
    qemuRepository: string;
    qemuCommit: string;
    qemuLicense: string;
  };
  cases: OracleCorpusCase[];
}

export interface OracleObservationSet {
  schema: typeof QEMU_ORACLE_OBSERVATION_SCHEMA;
  oracle: {
    kind: "espressif-qemu-gdb";
    repository: string;
    commit: string;
    machine: string;
    qemuPath: string;
    qemuSha256: string;
    qemuVersion: string;
    gdbPath: string;
    gdbVersion: string;
  };
  cases: OracleObservationCase[];
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseJsonFile(path: string): unknown {
  return JSON.parse(readFileSync(path, "utf8"));
}

function expectKeys(value: Record<string, unknown>, keys: readonly string[], label: string): void {
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  assert(
    JSON.stringify(actual) === JSON.stringify(expected),
    `${label} keys changed: ${actual.join(",")}`,
  );
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${label} must be an object`);
  return value as Record<string, unknown>;
}

function requireArray(value: unknown, label: string): unknown[] {
  assert(Array.isArray(value), `${label} must be an array`);
  return value;
}

function requireString(value: unknown, label: string): string {
  assert(typeof value === "string", `${label} must be a string`);
  return value;
}

function requirePositiveInteger(value: unknown, label: string): number {
  assert(Number.isInteger(value) && typeof value === "number" && value > 0, `${label} must be a positive integer`);
  return value;
}

function parseHexWord(value: unknown, label: string): number {
  const text = requireString(value, label);
  assert(/^0x[0-9a-f]{8}$/.test(text), `${label} must be a lowercase 32-bit hex word`);
  return Number.parseInt(text.slice(2), 16) >>> 0;
}

function parseHexBytes(value: unknown, label: string): string {
  const text = requireString(value, label);
  assert(text.length % 2 === 0, `${label} must contain full bytes`);
  assert(/^(?:[0-9a-f]{2})*$/.test(text), `${label} must be lowercase hex bytes`);
  return text;
}

function parseRegisterMap(value: unknown, label: string): Partial<Record<RegisterName, number>> {
  const record = requireObject(value, label);
  const parsed: Partial<Record<RegisterName, number>> = {};
  const names = Object.keys(record);
  const seen = new Set<string>();
  for (const name of names) {
    assert(REGISTER_NAME_SET.has(name), `${label} has unknown register ${name}`);
    assert(!seen.has(name), `${label} repeats register ${name}`);
    seen.add(name);
    parsed[name as RegisterName] = parseHexWord(record[name], `${label}.${name}`);
  }
  return parsed;
}

function parseObservedMemory(value: unknown, label: string): OracleObservedMemory[] {
  return requireArray(value, label).map((entry, index) => {
    const record = requireObject(entry, `${label}[${index}]`);
    expectKeys(record, ["address", "bytesHex"], `${label}[${index}]`);
    return {
      address: parseHexWord(record.address, `${label}[${index}].address`),
      bytesHex: parseHexBytes(record.bytesHex, `${label}[${index}].bytesHex`),
    };
  });
}

function parseObserveMemory(value: unknown, label: string): { address: number; length: number }[] {
  return requireArray(value, label).map((entry, index) => {
    const record = requireObject(entry, `${label}[${index}]`);
    expectKeys(record, ["address", "length"], `${label}[${index}]`);
    return {
      address: parseHexWord(record.address, `${label}[${index}].address`),
      length: requirePositiveInteger(record.length, `${label}[${index}].length`),
    };
  });
}

function parseObserveRegisters(value: unknown, label: string): RegisterName[] {
  const names = requireArray(value, label).map((entry, index) => requireString(entry, `${label}[${index}]`));
  const unique = new Set<string>();
  for (const name of names) {
    assert(REGISTER_NAME_SET.has(name), `${label} has unknown register ${name}`);
    assert(!unique.has(name), `${label} repeats register ${name}`);
    unique.add(name);
  }
  return names as RegisterName[];
}

function parseTrace(value: unknown, label: string): OracleTraceStep[] {
  return requireArray(value, label).map((entry, index) => {
    const record = requireObject(entry, `${label}[${index}]`);
    expectKeys(record, ["instructionBytesHex", "pc", "width"], `${label}[${index}]`);
    const width = requirePositiveInteger(record.width, `${label}[${index}].width`);
    assert(width === 2 || width === 3 || width === 4, `${label}[${index}].width must be 2, 3, or 4`);
    const instructionBytesHex = parseHexBytes(
      record.instructionBytesHex,
      `${label}[${index}].instructionBytesHex`,
    );
    assert(
      instructionBytesHex.length === width * 2,
      `${label}[${index}].instructionBytesHex must match width ${width}`,
    );
    return {
      pc: parseHexWord(record.pc, `${label}[${index}].pc`),
      width,
      instructionBytesHex,
    } as OracleTraceStep;
  });
}

function assertNonOverlappingMemory(
  memory: readonly { address: number; bytesHex?: string; length?: number }[],
  label: string,
): void {
  const spans = memory
    .map((entry) => ({
      start: entry.address >>> 0,
      end: (entry.address + ((entry.length ?? entry.bytesHex!.length / 2) >>> 0)) >>> 0,
    }))
    .sort((left, right) => left.start - right.start);
  for (let index = 1; index < spans.length; index++) {
    assert(spans[index - 1]!.end <= spans[index]!.start, `${label} has overlapping ranges`);
  }
}

function assertMatchesObservedMemory(
  observed: readonly OracleObservedMemory[],
  declared: readonly { address: number; length: number }[],
  label: string,
): void {
  assert(observed.length === declared.length, `${label} changed observed memory count`);
  for (const [index, entry] of observed.entries()) {
    const target = declared[index]!;
    assert(entry.address === target.address, `${label}[${index}] changed observed memory address`);
    assert(entry.bytesHex.length === target.length * 2, `${label}[${index}] changed observed memory length`);
  }
}

function assertTraceMatchesCode(
  caseId: string,
  pc: number,
  codeBytesHex: string,
  trace: readonly OracleTraceStep[],
  finalPc: number,
): void {
  let offset = 0;
  for (const [index, step] of trace.entries()) {
    assert(step.pc === ((pc + offset) >>> 0), `${caseId} trace ${index} changed PC`);
    const expectedHex = codeBytesHex.slice(offset * 2, offset * 2 + step.width * 2);
    assert(expectedHex === step.instructionBytesHex, `${caseId} trace ${index} changed instruction bytes`);
    offset += step.width;
  }
  assert(finalPc === ((pc + offset) >>> 0), `${caseId} changed final PC`);
}

function parseReferenceCase(
  value: unknown,
  label: string,
  caseId: string,
  pc: number,
  instructionBudget: number,
  codeBytesHex: string,
  observeRegisters: readonly RegisterName[],
  observeMemory: readonly { address: number; length: number }[],
): OracleObservationCase {
  const record = requireObject(value, label);
  expectKeys(record, ["finalPc", "memory", "registers", "steps", "termination", "trace"], label);
  const registers = parseRegisterMap(record.registers, `${label}.registers`);
  const registerNames = Object.keys(registers).sort();
  assert(
    JSON.stringify(registerNames) === JSON.stringify([...observeRegisters].sort()),
    `${label}.registers changed observed register set`,
  );
  const memory = parseObservedMemory(record.memory, `${label}.memory`);
  assertMatchesObservedMemory(memory, observeMemory, `${label}.memory`);
  const trace = parseTrace(record.trace, `${label}.trace`);
  const steps = requirePositiveInteger(record.steps, `${label}.steps`);
  assert(steps === instructionBudget, `${label}.steps changed instruction budget`);
  assert(trace.length === instructionBudget, `${label}.trace changed instruction budget`);
  const termination = requireString(record.termination, `${label}.termination`);
  assert(termination === QEMU_ORACLE_TERMINATION, `${label}.termination must be ${QEMU_ORACLE_TERMINATION}`);
  const finalPc = parseHexWord(record.finalPc, `${label}.finalPc`);
  assertTraceMatchesCode(caseId, pc, codeBytesHex, trace, finalPc);
  return { id: caseId, termination, finalPc, steps, registers, memory, trace };
}

function parseCorpusCase(value: unknown, label: string): OracleCorpusCase {
  const record = requireObject(value, label);
  expectKeys(
    record,
    [
      "codeBytesHex",
      "description",
      "id",
      "initialMemory",
      "initialRegisters",
      "instructionBudget",
      "observeMemory",
      "observeRegisters",
      "pc",
      "reference",
    ],
    label,
  );
  const id = requireString(record.id, `${label}.id`);
  const description = requireString(record.description, `${label}.description`);
  const pc = parseHexWord(record.pc, `${label}.pc`);
  const instructionBudget = requirePositiveInteger(record.instructionBudget, `${label}.instructionBudget`);
  const codeBytesHex = parseHexBytes(record.codeBytesHex, `${label}.codeBytesHex`);
  const initialRegisters = parseRegisterMap(record.initialRegisters, `${label}.initialRegisters`);
  const initialMemory = parseObservedMemory(record.initialMemory, `${label}.initialMemory`);
  assertNonOverlappingMemory(initialMemory, `${label}.initialMemory`);
  const observeRegisters = parseObserveRegisters(record.observeRegisters, `${label}.observeRegisters`);
  const observeMemory = parseObserveMemory(record.observeMemory, `${label}.observeMemory`);
  assertNonOverlappingMemory(observeMemory, `${label}.observeMemory`);
  const codeEnd = (pc + codeBytesHex.length / 2) >>> 0;
  for (const [index, memory] of initialMemory.entries()) {
    const memoryEnd = (memory.address + memory.bytesHex.length / 2) >>> 0;
    assert(
      memoryEnd <= pc || memory.address >= codeEnd,
      `${label}.initialMemory[${index}] overlaps code bytes`,
    );
  }
  const reference = parseReferenceCase(
    record.reference,
    `${label}.reference`,
    id,
    pc,
    instructionBudget,
    codeBytesHex,
    observeRegisters,
    observeMemory,
  );
  return {
    ...reference,
    description,
    pc,
    instructionBudget,
    codeBytesHex,
    initialRegisters,
    initialMemory,
    observeRegisters,
    observeMemory,
  };
}

export function parseCorpus(value: unknown): OracleCorpus {
  const record = requireObject(value, "corpus");
  expectKeys(record, ["cases", "provenance", "schema"], "corpus");
  const schema = requireString(record.schema, "corpus.schema");
  assert(schema === QEMU_ORACLE_CORPUS_SCHEMA, `corpus.schema must be ${QEMU_ORACLE_CORPUS_SCHEMA}`);
  const provenance = requireObject(record.provenance, "corpus.provenance");
  expectKeys(
    provenance,
    ["flexeCommit", "flexeRepository", "qemuCommit", "qemuLicense", "qemuRepository"],
    "corpus.provenance",
  );
  assert(provenance.flexeRepository === FLEXE_REPOSITORY, "corpus.provenance.flexeRepository changed");
  assert(provenance.flexeCommit === FLEXE_COMMIT, "corpus.provenance.flexeCommit changed");
  assert(provenance.qemuRepository === ESPRESSIF_QEMU_REPOSITORY, "corpus.provenance.qemuRepository changed");
  assert(provenance.qemuCommit === ESPRESSIF_QEMU_COMMIT, "corpus.provenance.qemuCommit changed");
  assert(provenance.qemuLicense === ESPRESSIF_QEMU_LICENSE, "corpus.provenance.qemuLicense changed");
  const cases = requireArray(record.cases, "corpus.cases").map((entry, index) => parseCorpusCase(entry, `corpus.cases[${index}]`));
  const ids = new Set<string>();
  for (const caseEntry of cases) {
    assert(!ids.has(caseEntry.id), `corpus repeats case id ${caseEntry.id}`);
    ids.add(caseEntry.id);
  }
  return {
    schema,
    provenance: {
      flexeRepository: provenance.flexeRepository as string,
      flexeCommit: provenance.flexeCommit as string,
      qemuRepository: provenance.qemuRepository as string,
      qemuCommit: provenance.qemuCommit as string,
      qemuLicense: provenance.qemuLicense as string,
    },
    cases,
  };
}

function parseObservationCase(value: unknown, label: string): OracleObservationCase {
  const record = requireObject(value, label);
  expectKeys(record, ["finalPc", "id", "memory", "registers", "steps", "termination", "trace"], label);
  const id = requireString(record.id, `${label}.id`);
  const termination = requireString(record.termination, `${label}.termination`);
  assert(termination === QEMU_ORACLE_TERMINATION, `${label}.termination must be ${QEMU_ORACLE_TERMINATION}`);
  return {
    id,
    termination,
    finalPc: parseHexWord(record.finalPc, `${label}.finalPc`),
    steps: requirePositiveInteger(record.steps, `${label}.steps`),
    registers: parseRegisterMap(record.registers, `${label}.registers`),
    memory: parseObservedMemory(record.memory, `${label}.memory`),
    trace: parseTrace(record.trace, `${label}.trace`),
  };
}

export function parseObservationSet(value: unknown): OracleObservationSet {
  const record = requireObject(value, "observation");
  expectKeys(record, ["cases", "oracle", "schema"], "observation");
  const schema = requireString(record.schema, "observation.schema");
  assert(schema === QEMU_ORACLE_OBSERVATION_SCHEMA, `observation.schema must be ${QEMU_ORACLE_OBSERVATION_SCHEMA}`);
  const oracle = requireObject(record.oracle, "observation.oracle");
  expectKeys(
    oracle,
    ["commit", "gdbPath", "gdbVersion", "kind", "machine", "qemuPath", "qemuSha256", "qemuVersion", "repository"],
    "observation.oracle",
  );
  assert(oracle.kind === "espressif-qemu-gdb", "observation.oracle.kind changed");
  assert(oracle.repository === ESPRESSIF_QEMU_REPOSITORY, "observation.oracle.repository changed");
  assert(oracle.commit === ESPRESSIF_QEMU_COMMIT, "observation.oracle.commit changed");
  assert(oracle.machine === ESP32S3_QEMU_MACHINE, "observation.oracle.machine changed");
  requireString(oracle.qemuPath, "observation.oracle.qemuPath");
  requireString(oracle.qemuSha256, "observation.oracle.qemuSha256");
  requireString(oracle.qemuVersion, "observation.oracle.qemuVersion");
  requireString(oracle.gdbPath, "observation.oracle.gdbPath");
  requireString(oracle.gdbVersion, "observation.oracle.gdbVersion");
  const cases = requireArray(record.cases, "observation.cases").map((entry, index) =>
    parseObservationCase(entry, `observation.cases[${index}]`),
  );
  const ids = new Set<string>();
  for (const caseEntry of cases) {
    assert(!ids.has(caseEntry.id), `observation repeats case id ${caseEntry.id}`);
    ids.add(caseEntry.id);
  }
  return {
    schema,
    oracle: {
      kind: "espressif-qemu-gdb",
      repository: oracle.repository as string,
      commit: oracle.commit as string,
      machine: oracle.machine as string,
      qemuPath: oracle.qemuPath as string,
      qemuSha256: oracle.qemuSha256 as string,
      qemuVersion: oracle.qemuVersion as string,
      gdbPath: oracle.gdbPath as string,
      gdbVersion: oracle.gdbVersion as string,
    },
    cases,
  };
}

function compareRegisters(
  expected: Partial<Record<RegisterName, number>>,
  actual: Partial<Record<RegisterName, number>>,
  label: string,
): string[] {
  const expectedNames = Object.keys(expected).sort();
  const actualNames = Object.keys(actual).sort();
  if (JSON.stringify(expectedNames) !== JSON.stringify(actualNames)) {
    return [`${label} changed register set`];
  }
  const mismatches: string[] = [];
  for (const name of expectedNames) {
    if (expected[name as RegisterName] !== actual[name as RegisterName]) {
      mismatches.push(`${label}.${name} changed`);
    }
  }
  return mismatches;
}

function compareMemory(
  expected: readonly OracleObservedMemory[],
  actual: readonly OracleObservedMemory[],
  label: string,
): string[] {
  const mismatches: string[] = [];
  if (expected.length !== actual.length) {
    return [`${label} changed observed memory count`];
  }
  for (const [index, entry] of expected.entries()) {
    const other = actual[index]!;
    if (entry.address !== other.address) mismatches.push(`${label}[${index}] changed address`);
    if (entry.bytesHex !== other.bytesHex) mismatches.push(`${label}[${index}] changed bytes`);
  }
  return mismatches;
}

function compareTrace(
  expected: readonly OracleTraceStep[],
  actual: readonly OracleTraceStep[],
  label: string,
): string[] {
  const mismatches: string[] = [];
  if (expected.length !== actual.length) {
    return [`${label} changed step count`];
  }
  for (const [index, step] of expected.entries()) {
    const other = actual[index]!;
    if (step.pc !== other.pc) mismatches.push(`${label}[${index}] changed PC`);
    if (step.width !== other.width) mismatches.push(`${label}[${index}] changed width`);
    if (step.instructionBytesHex !== other.instructionBytesHex) {
      mismatches.push(`${label}[${index}] changed instruction bytes`);
    }
  }
  return mismatches;
}

export function compareObservationToCorpus(
  corpus: OracleCorpus,
  observation: OracleObservationSet,
): string[] {
  const expectedCases = new Map(corpus.cases.map((entry) => [entry.id, entry]));
  const actualCases = new Map(observation.cases.map((entry) => [entry.id, entry]));
  const expectedIds = [...expectedCases.keys()].sort();
  const actualIds = [...actualCases.keys()].sort();
  if (JSON.stringify(expectedIds) !== JSON.stringify(actualIds)) {
    return ["observation changed case set"];
  }
  const mismatches: string[] = [];
  for (const caseId of expectedIds) {
    const expected = expectedCases.get(caseId)!;
    const actual = actualCases.get(caseId)!;
    if (expected.termination !== actual.termination) mismatches.push(`${caseId} changed termination`);
    if (expected.finalPc !== actual.finalPc) mismatches.push(`${caseId} changed final PC`);
    if (expected.steps !== actual.steps) mismatches.push(`${caseId} changed step count`);
    mismatches.push(...compareRegisters(expected.registers, actual.registers, `${caseId}.registers`));
    mismatches.push(...compareMemory(expected.memory, actual.memory, `${caseId}.memory`));
    mismatches.push(...compareTrace(expected.trace, actual.trace, `${caseId}.trace`));
  }
  return mismatches;
}

export function loadCorpus(path = DEFAULT_CORPUS_PATH): OracleCorpus {
  return parseCorpus(parseJsonFile(path));
}

export function loadObservationSet(path = DEFAULT_FIXTURE_OBSERVATION_PATH): OracleObservationSet {
  return parseObservationSet(parseJsonFile(path));
}

export function formatHexWord(value: number): string {
  return `0x${(value >>> 0).toString(16).padStart(8, "0")}`;
}
