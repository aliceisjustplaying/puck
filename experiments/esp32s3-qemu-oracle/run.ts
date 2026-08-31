import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  DEFAULT_CORPUS_PATH,
  ESP32S3_QEMU_MACHINE,
  ESPRESSIF_QEMU_BRANCH,
  ESPRESSIF_QEMU_COMMIT,
  ESPRESSIF_QEMU_REPOSITORY,
  QEMU_ORACLE_OBSERVATION_SCHEMA,
  QEMU_ORACLE_TERMINATION,
  REGISTER_NAMES,
} from "./constants";
import {
  formatHexWord,
  parseCorpus,
  type OracleCorpus,
  type OracleCorpusCase,
  type OracleObservationCase,
  type OracleObservationSet,
} from "./oracle";

interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface LiveOracleEnvironment {
  qemuExe: string;
  gdbExe: string;
  qemuVersion: string;
  gdbVersion: string;
  qemuSha256: string;
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function run(command: string[]): CommandResult {
  const result = Bun.spawnSync(command, {
    env: process.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    command: command.join(" "),
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString(),
  };
}

function requireSuccess(result: CommandResult): CommandResult {
  if (result.exitCode === 0) return result;
  throw new Error(`${result.command} exited ${result.exitCode}\n${result.stdout}${result.stderr}`);
}

function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

function parseArgs(argv: readonly string[]): { corpusPath: string } {
  let corpusPath = DEFAULT_CORPUS_PATH;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--corpus") {
      assert(index + 1 < argv.length, "--corpus needs a path");
      corpusPath = resolve(argv[index + 1]!);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argv[index]}`);
  }
  return { corpusPath };
}

export function detectLiveOracleEnvironment(env = process.env): { ready: true; value: LiveOracleEnvironment } | {
  ready: false;
  reason: string[];
} {
  const reasons: string[] = [];
  const qemuExe = env.ESP32S3_QEMU_EXE ?? "qemu-system-xtensa";
  const gdbExe = env.ESP32S3_GDB_EXE ?? "xtensa-esp32s3-elf-gdb";
  const declaredCommit = env.ESP32S3_QEMU_COMMIT;
  if (declaredCommit !== ESPRESSIF_QEMU_COMMIT) {
    reasons.push(`set ESP32S3_QEMU_COMMIT=${ESPRESSIF_QEMU_COMMIT}`);
  }
  let qemuVersion = "";
  let gdbVersion = "";
  let qemuSha256 = "";
  try {
    qemuVersion = requireSuccess(run([qemuExe, "--version"])).stdout.trim();
  } catch {
    reasons.push(`${qemuExe} is not available`);
  }
  try {
    gdbVersion = requireSuccess(run([gdbExe, "--version"])).stdout.trim().split(/\r?\n/u)[0] ?? "";
  } catch {
    reasons.push(`${gdbExe} is not available`);
  }
  const qemuPathResult = run(["which", qemuExe]);
  if (qemuPathResult.exitCode === 0) {
    const qemuPath = qemuPathResult.stdout.trim();
    if (qemuPath !== "") qemuSha256 = sha256(qemuPath);
  }
  if (reasons.length > 0) {
    return { ready: false, reason: reasons };
  }
  assert(qemuSha256 !== "", `could not resolve ${qemuExe} on PATH`);
  return {
    ready: true,
    value: { qemuExe, gdbExe, qemuVersion, gdbVersion, qemuSha256 },
  };
}

async function readSubprocessStream(stream: number | ReadableStream<Uint8Array> | undefined): Promise<string> {
  if (!(stream instanceof ReadableStream)) return "";
  return new Response(stream).text();
}

async function waitForPath(path: string, processHandle: Bun.Subprocess): Promise<void> {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (existsSync(path)) return;
    const exitCode = processHandle.exitCode;
    if (exitCode !== null) {
      const stderr = await readSubprocessStream(processHandle.stderr);
      throw new Error(`qemu exited ${exitCode} before opening ${path}\n${stderr}`);
    }
    await Bun.sleep(50);
  }
  throw new Error(`timed out waiting for ${path}`);
}

function registerLines(initial: OracleCorpusCase["initialRegisters"]): string[] {
  const lines = REGISTER_NAMES.map((name) => `set $${name} = ${formatHexWord(0)}`);
  for (const [name, value] of Object.entries(initial)) {
    lines.push(`set $${name} = ${formatHexWord(value!)}`);
  }
  return lines;
}

function memoryWriteLines(address: number, bytesHex: string): string[] {
  const lines: string[] = [];
  for (let offset = 0; offset < bytesHex.length / 2; offset++) {
    const byteHex = bytesHex.slice(offset * 2, offset * 2 + 2);
    lines.push(`set {unsigned char}${formatHexWord((address + offset) >>> 0)} = 0x${byteHex}`);
  }
  return lines;
}

function memoryReadLines(caseEntry: OracleCorpusCase): string[] {
  const lines: string[] = [];
  for (const region of caseEntry.observeMemory) {
    for (let offset = 0; offset < region.length; offset++) {
      const address = (region.address + offset) >>> 0;
      lines.push(
        `printf "PUCK_MEM ${caseEntry.id} ${formatHexWord(address)} 0x%02x\\n", ((unsigned int)(*(unsigned char *)${formatHexWord(address)}))`,
      );
    }
  }
  return lines;
}

function buildGdbScript(caseEntry: OracleCorpusCase, socketPath: string): string {
  const lines = [
    "set pagination off",
    "set confirm off",
    "set width 0",
    "set height 0",
    "set remotetimeout 5",
    `target remote ${socketPath}`,
    ...registerLines(caseEntry.initialRegisters),
    `set $pc = ${formatHexWord(caseEntry.pc)}`,
    ...memoryWriteLines(caseEntry.pc, caseEntry.codeBytesHex),
    ...caseEntry.initialMemory.flatMap((entry) => memoryWriteLines(entry.address, entry.bytesHex)),
    ...caseEntry.trace.flatMap((step, index) => [
      `printf "PUCK_TRACE ${caseEntry.id} ${index} ${formatHexWord(step.pc)}\\n"`,
      `x/${step.width}bx ${formatHexWord(step.pc)}`,
      "stepi",
    ]),
    `printf "PUCK_FINAL ${caseEntry.id} 0x%08x\\n", ((unsigned int)$pc)`,
    ...caseEntry.observeRegisters.map(
      (name) => `printf "PUCK_REG ${caseEntry.id} ${name} 0x%08x\\n", ((unsigned int)$${name})`,
    ),
    ...memoryReadLines(caseEntry),
    "disconnect",
    "quit",
  ];
  return `${lines.join("\n")}\n`;
}

function parseTraceBytes(line: string, width: number): string {
  const colon = line.indexOf(":");
  assert(colon >= 0, `could not parse GDB memory line: ${line}`);
  const bytes = [...line.slice(colon + 1).matchAll(/0x([0-9a-fA-F]{2})/gu)].map((match) => match[1]!.toLowerCase());
  assert(bytes.length >= width, `GDB returned ${bytes.length} bytes, expected ${width}`);
  return bytes.slice(0, width).join("");
}

function parseCaseOutput(caseEntry: OracleCorpusCase, output: string): OracleObservationCase {
  const lines = output.split(/\r?\n/u);
  const trace = Array<OracleObservationCase["trace"][number]>();
  const registers = {} as OracleObservationCase["registers"];
  const memoryBytes = new Map<number, string>();
  let pendingTrace: { index: number; pc: number; width: number } | null = null;
  let finalPc: number | null = null;
  for (const line of lines) {
    if (pendingTrace) {
      trace[pendingTrace.index] = {
        pc: pendingTrace.pc,
        width: pendingTrace.width as 2 | 3 | 4,
        instructionBytesHex: parseTraceBytes(line, pendingTrace.width),
      };
      pendingTrace = null;
      continue;
    }
    let match = /^PUCK_TRACE (\S+) (\d+) (0x[0-9a-f]{8})$/u.exec(line);
    if (match) {
      const [, id, indexText, pcText] = match;
      assert(id === caseEntry.id, `GDB returned trace for unexpected case ${id}`);
      const index = Number.parseInt(indexText, 10);
      const expected = caseEntry.trace[index];
      assert(expected, `GDB returned unexpected trace index ${index}`);
      pendingTrace = { index, pc: Number.parseInt(pcText.slice(2), 16) >>> 0, width: expected.width };
      continue;
    }
    match = /^PUCK_FINAL (\S+) (0x[0-9a-f]{8})$/u.exec(line);
    if (match) {
      const [, id, pcText] = match;
      assert(id === caseEntry.id, `GDB returned final PC for unexpected case ${id}`);
      finalPc = Number.parseInt(pcText.slice(2), 16) >>> 0;
      continue;
    }
    match = /^PUCK_REG (\S+) (a\d+) (0x[0-9a-f]{8})$/u.exec(line);
    if (match) {
      const [, id, registerName, value] = match;
      assert(id === caseEntry.id, `GDB returned register for unexpected case ${id}`);
      registers[registerName as keyof typeof registers] = Number.parseInt(value.slice(2), 16) >>> 0;
      continue;
    }
    match = /^PUCK_MEM (\S+) (0x[0-9a-f]{8}) 0x([0-9a-f]{2})$/u.exec(line);
    if (match) {
      const [, id, addressText, byteText] = match;
      assert(id === caseEntry.id, `GDB returned memory for unexpected case ${id}`);
      memoryBytes.set(Number.parseInt(addressText.slice(2), 16) >>> 0, byteText.toLowerCase());
    }
  }
  assert(pendingTrace === null, `${caseEntry.id} ended before the last trace byte dump`);
  assert(finalPc !== null, `${caseEntry.id} did not produce a final PC`);
  const memory = caseEntry.observeMemory.map((region) => {
    let bytesHex = "";
    for (let offset = 0; offset < region.length; offset++) {
      const address = (region.address + offset) >>> 0;
      const byte = memoryBytes.get(address);
      assert(byte !== undefined, `${caseEntry.id} is missing byte ${formatHexWord(address)}`);
      bytesHex += byte;
    }
    return { address: region.address, bytesHex };
  });
  return {
    id: caseEntry.id,
    termination: QEMU_ORACLE_TERMINATION,
    finalPc,
    steps: caseEntry.instructionBudget,
    registers,
    memory,
    trace,
  };
}

async function terminate(processHandle: Bun.Subprocess): Promise<void> {
  processHandle.kill("SIGTERM");
  try {
    await processHandle.exited;
  } catch {
    processHandle.kill("SIGKILL");
    await processHandle.exited;
  }
}

async function runCase(caseEntry: OracleCorpusCase, live: LiveOracleEnvironment): Promise<OracleObservationCase> {
  const temp = mkdtempSync(join(tmpdir(), "puck-esp32s3-qemu-"));
  const socketPath = join(temp, "gdb.sock");
  const scriptPath = join(temp, "case.gdb");
  writeFileSync(scriptPath, buildGdbScript(caseEntry, socketPath));
  const qemu = Bun.spawn(
    [
      live.qemuExe,
      "-nographic",
      "-machine",
      ESP32S3_QEMU_MACHINE,
      "-monitor",
      "none",
      "-serial",
      "none",
      "-chardev",
      `socket,path=${socketPath},server=on,wait=off,id=gdb0`,
      "-gdb",
      "chardev:gdb0",
      "-S",
    ],
    {
      env: process.env,
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  try {
    await waitForPath(socketPath, qemu);
    const gdb = run([live.gdbExe, "--quiet", "--batch", "--nx", "-x", scriptPath]);
    if (gdb.exitCode !== 0) {
      const qemuStderr = await readSubprocessStream(qemu.stderr);
      throw new Error(`${gdb.command} exited ${gdb.exitCode}\n${gdb.stdout}${gdb.stderr}${qemuStderr}`);
    }
    return parseCaseOutput(caseEntry, gdb.stdout);
  } finally {
    await terminate(qemu);
    rmSync(temp, { force: true, recursive: true });
  }
}

export async function runLiveOracle(
  corpus: OracleCorpus,
  live: LiveOracleEnvironment,
): Promise<OracleObservationSet> {
  const cases: OracleObservationCase[] = [];
  for (const caseEntry of corpus.cases) {
    cases.push(await runCase(caseEntry, live));
  }
  return {
    schema: QEMU_ORACLE_OBSERVATION_SCHEMA,
    oracle: {
      kind: "espressif-qemu-gdb",
      repository: ESPRESSIF_QEMU_REPOSITORY,
      commit: ESPRESSIF_QEMU_COMMIT,
      machine: ESP32S3_QEMU_MACHINE,
      qemuPath: live.qemuExe,
      qemuSha256: live.qemuSha256,
      qemuVersion: `${live.qemuVersion} [branch ${ESPRESSIF_QEMU_BRANCH}]`,
      gdbPath: live.gdbExe,
      gdbVersion: live.gdbVersion,
    },
    cases,
  };
}

if (import.meta.main) {
  const args = parseArgs(Bun.argv.slice(2));
  const corpus = parseCorpus(JSON.parse(readFileSync(resolve(args.corpusPath), "utf8")));
  const detected = detectLiveOracleEnvironment();
  if (!detected.ready) {
    throw new Error(detected.reason.join("\n"));
  }
  const observation = await runLiveOracle(corpus, detected.value);
  console.log(JSON.stringify(observation, null, 2));
}
