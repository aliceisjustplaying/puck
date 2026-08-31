/*
 * Bounded ROM contract for direct entry into TinyDraw's ESP-IDF v6.0.2 app.
 * Reset-through-bootloader register defaults are outside this slice. The two
 * final enables are cache_hal_init repeating do_multicore_settings' enables.
 */
export const ESP32S3_ROM_CACHE_CALLBACKS = Object.freeze({
  disableInstruction: 0x4000_186c,
  enableInstruction: 0x4000_1878,
  disableData: 0x4000_1884,
  enableData: 0x4000_1890,
});

export const ESP32S3_ROM_CACHE_MODE_CALLBACKS = Object.freeze({
  configureInstruction: 0x4000_1a1c,
  suspendData: 0x4000_18b4,
  configureData: 0x4000_1a28,
});

export const ESP32S3_CACHE_REGISTER_ADDRESSES = Object.freeze({
  dataControl1: 0x600c_4004,
  dataAutoloadControl: 0x600c_404c,
  instructionControl1: 0x600c_4064,
  instructionAutoloadControl: 0x600c_40a0,
  cacheState: 0x600c_4130,
});

export const ESP32S3_DIRECT_APP_CACHE_REGISTERS = Object.freeze({
  dataControl1: 0,
  dataAutoloadControl: 8,
  instructionControl1: 0,
  instructionAutoloadControl: 8,
  cacheState: 0x0010_01,
});

export const ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE = Object.freeze({
  sizeBytes: 0x4000,
  ways: 8,
  lineBytes: 32,
});

export const ESP32S3_DIRECT_APP_DATA_CACHE_MODE = Object.freeze({
  sizeBytes: 0x8000,
  ways: 8,
  lineBytes: 64,
});

const CACHE_IDLE_STATE = 0x0010_01;
const AUTOLOAD_ENABLE = 1 << 2;
const CORE0_INSTRUCTION_SHUT = 1 << 0;
// ESP32-S3 routes core 0's DBUS through the CTRL1 core-1-named bit.
const CORE0_DATA_SHUT = 1 << 1;
export const ESP32S3_ROM_CACHE_CALLINC = 2;

export type Esp32S3RomCacheOperation =
  | "disable-instruction"
  | "disable-data"
  | "enable-instruction"
  | "enable-data"
  | "configure-instruction"
  | "suspend-data"
  | "configure-data";

export interface Esp32S3RomCacheCall {
  readonly pc: number;
  readonly arguments: readonly number[];
  readonly operation: Esp32S3RomCacheOperation;
}

export const ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE: readonly Esp32S3RomCacheCall[] =
  Object.freeze([
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction,
      arguments: Object.freeze([]),
      operation: "disable-instruction" as const,
    }),
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.disableData,
      arguments: Object.freeze([]),
      operation: "disable-data" as const,
    }),
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.enableInstruction,
      arguments: Object.freeze([0]),
      operation: "enable-instruction" as const,
    }),
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.enableData,
      arguments: Object.freeze([0]),
      operation: "enable-data" as const,
    }),
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.enableInstruction,
      arguments: Object.freeze([0]),
      operation: "enable-instruction" as const,
    }),
    Object.freeze({
      pc: ESP32S3_ROM_CACHE_CALLBACKS.enableData,
      arguments: Object.freeze([0]),
      operation: "enable-data" as const,
    }),
  ]);

export interface Esp32S3DirectAppCacheRegisters {
  readonly dataControl1: number;
  readonly dataAutoloadControl: number;
  readonly instructionControl1: number;
  readonly instructionAutoloadControl: number;
  readonly cacheState: number;
}

export interface Esp32S3DirectAppCacheBootstrapState {
  readonly sequenceIndex: number;
  readonly complete: boolean;
  readonly registers: Esp32S3DirectAppCacheRegisters;
  readonly instructionMode: Esp32S3InstructionCacheMode | null;
  readonly dataSuspended: boolean;
  readonly dataMode: Esp32S3InstructionCacheMode | null;
}

export interface Esp32S3InstructionCacheMode {
  readonly sizeBytes: number;
  readonly ways: number;
  readonly lineBytes: number;
}

export interface Esp32S3RomCacheInvocation {
  readonly pc: number;
  readonly callinc: number;
  readonly arguments: readonly number[];
}

export type Esp32S3RomCacheDispatch =
  | Readonly<{ handled: false; status?: never }>
  | Readonly<{
      handled: true;
      status: "refused";
      reason: string;
      state: Esp32S3DirectAppCacheBootstrapState;
    }>
  | Readonly<{
      handled: true;
      status: "accepted";
      operation: Esp32S3RomCacheOperation;
      returnValue: number | null;
      state: Esp32S3DirectAppCacheBootstrapState;
    }>;

function freezeState(
  sequenceIndex: number,
  registers: Esp32S3DirectAppCacheRegisters,
  instructionMode: Esp32S3InstructionCacheMode | null = null,
  dataSuspended = false,
  dataMode: Esp32S3InstructionCacheMode | null = null,
): Esp32S3DirectAppCacheBootstrapState {
  return Object.freeze({
    sequenceIndex,
    complete: sequenceIndex === ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE.length,
    registers: Object.freeze({ ...registers }),
    instructionMode: instructionMode ? Object.freeze({ ...instructionMode }) : null,
    dataSuspended,
    dataMode: dataMode ? Object.freeze({ ...dataMode }) : null,
  });
}

export function createEsp32S3DirectAppCacheBootstrap(): Esp32S3DirectAppCacheBootstrapState {
  return freezeState(0, ESP32S3_DIRECT_APP_CACHE_REGISTERS);
}

function refuse(
  state: Esp32S3DirectAppCacheBootstrapState,
  reason: string,
): Esp32S3RomCacheDispatch {
  return Object.freeze({ handled: true, status: "refused", reason, state });
}

function isKnownCallback(pc: number): boolean {
  return (Object.values(ESP32S3_ROM_CACHE_CALLBACKS) as readonly number[]).includes(pc);
}

function sameArguments(actual: readonly number[], expected: readonly number[]): boolean {
  return actual.length === expected.length && actual.every((value, index) => value === expected[index]);
}

export function advanceEsp32S3DirectAppCacheBootstrap(
  state: Esp32S3DirectAppCacheBootstrapState,
  invocation: Esp32S3RomCacheInvocation,
): Esp32S3RomCacheDispatch {
  if (!isKnownCallback(invocation.pc)) return Object.freeze({ handled: false });
  if (invocation.callinc !== ESP32S3_ROM_CACHE_CALLINC) {
    return refuse(state, `cache callback CALLINC must be ${ESP32S3_ROM_CACHE_CALLINC}`);
  }
  if (state.registers.cacheState !== CACHE_IDLE_STATE) {
    return refuse(state, `cache controller is not idle: 0x${state.registers.cacheState.toString(16)}`);
  }
  const expected = ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE[state.sequenceIndex];
  if (!expected) return refuse(state, "direct app cache bootstrap is already complete");
  if (invocation.pc !== expected.pc) {
    return refuse(
      state,
      `unexpected cache callback 0x${invocation.pc.toString(16)} at sequence index ${state.sequenceIndex}`,
    );
  }
  if (!invocation.arguments.every((value) => Number.isSafeInteger(value) && value >= 0 && value <= 0xffff_ffff)) {
    return refuse(state, "cache callback arguments must be unsigned 32-bit integers");
  }
  if (!sameArguments(invocation.arguments, expected.arguments)) {
    return refuse(
      state,
      `unexpected arguments for ${expected.operation}: expected ${expected.arguments.join(",") || "none"}`,
    );
  }

  const registers = { ...state.registers };
  let returnValue: number | null = null;
  switch (expected.operation) {
    case "disable-instruction":
      returnValue = registers.instructionAutoloadControl & AUTOLOAD_ENABLE;
      registers.instructionAutoloadControl &= ~AUTOLOAD_ENABLE;
      registers.instructionControl1 |= CORE0_INSTRUCTION_SHUT;
      break;
    case "disable-data":
      returnValue = registers.dataAutoloadControl & AUTOLOAD_ENABLE;
      registers.dataAutoloadControl &= ~AUTOLOAD_ENABLE;
      registers.dataControl1 |= CORE0_DATA_SHUT;
      break;
    case "enable-instruction":
      registers.instructionAutoloadControl =
        (registers.instructionAutoloadControl & ~AUTOLOAD_ENABLE) | invocation.arguments[0]!;
      registers.instructionControl1 &= ~CORE0_INSTRUCTION_SHUT;
      break;
    case "enable-data":
      registers.dataAutoloadControl =
        (registers.dataAutoloadControl & ~AUTOLOAD_ENABLE) | invocation.arguments[0]!;
      registers.dataControl1 &= ~CORE0_DATA_SHUT;
      break;
  }

  return Object.freeze({
    handled: true,
    status: "accepted",
    operation: expected.operation,
    returnValue,
    state: freezeState(
      state.sequenceIndex + 1,
      registers,
      state.instructionMode,
      state.dataSuspended,
      state.dataMode,
    ),
  });
}

function directAppCacheRegistersMatch(registers: Esp32S3DirectAppCacheRegisters): boolean {
  return Object.entries(ESP32S3_DIRECT_APP_CACHE_REGISTERS).every(
    ([name, value]) => registers[name as keyof Esp32S3DirectAppCacheRegisters] === value,
  );
}

export function configureEsp32S3DirectAppInstructionCache(
  state: Esp32S3DirectAppCacheBootstrapState,
  invocation: Esp32S3RomCacheInvocation,
): Esp32S3RomCacheDispatch {
  if (invocation.pc !== ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction) {
    return Object.freeze({ handled: false });
  }
  if (invocation.callinc !== ESP32S3_ROM_CACHE_CALLINC) {
    return refuse(state, `cache callback CALLINC must be ${ESP32S3_ROM_CACHE_CALLINC}`);
  }
  if (!state.complete) return refuse(state, "instruction cache mode requires completed cache bootstrap");
  if (state.instructionMode) return refuse(state, "instruction cache mode is already configured");
  if (!directAppCacheRegistersMatch(state.registers)) {
    return refuse(state, "instruction cache mode requires direct app cache register state");
  }
  const expected = Object.values(ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE);
  if (!sameArguments(invocation.arguments, expected)) {
    return refuse(state, `unexpected instruction cache mode arguments: expected ${expected.join(",")}`);
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    operation: "configure-instruction",
    returnValue: null,
    state: freezeState(
      state.sequenceIndex,
      state.registers,
      ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE,
      state.dataSuspended,
      state.dataMode,
    ),
  });
}

export function suspendEsp32S3DirectAppDataCache(
  state: Esp32S3DirectAppCacheBootstrapState,
  invocation: Esp32S3RomCacheInvocation,
): Esp32S3RomCacheDispatch {
  if (invocation.pc !== ESP32S3_ROM_CACHE_MODE_CALLBACKS.suspendData) {
    return Object.freeze({ handled: false });
  }
  if (invocation.callinc !== ESP32S3_ROM_CACHE_CALLINC) {
    return refuse(state, `cache callback CALLINC must be ${ESP32S3_ROM_CACHE_CALLINC}`);
  }
  if (!state.instructionMode) return refuse(state, "data cache suspension requires instruction cache mode");
  if (state.dataSuspended) return refuse(state, "data cache is already suspended");
  if (!directAppCacheRegistersMatch(state.registers)) {
    return refuse(state, "data cache suspension requires direct app cache register state");
  }
  if (invocation.arguments.length !== 0) return refuse(state, "data cache suspension takes no arguments");

  const registers = { ...state.registers };
  const returnValue = registers.dataAutoloadControl & AUTOLOAD_ENABLE;
  registers.dataControl1 |= 3;
  if (returnValue !== 0) registers.dataAutoloadControl &= ~AUTOLOAD_ENABLE;
  return Object.freeze({
    handled: true,
    status: "accepted",
    operation: "suspend-data",
    returnValue,
    state: freezeState(state.sequenceIndex, registers, state.instructionMode, true, state.dataMode),
  });
}

export function configureEsp32S3DirectAppDataCache(
  state: Esp32S3DirectAppCacheBootstrapState,
  invocation: Esp32S3RomCacheInvocation,
): Esp32S3RomCacheDispatch {
  if (invocation.pc !== ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureData) {
    return Object.freeze({ handled: false });
  }
  if (invocation.callinc !== ESP32S3_ROM_CACHE_CALLINC) {
    return refuse(state, `cache callback CALLINC must be ${ESP32S3_ROM_CACHE_CALLINC}`);
  }
  if (!state.instructionMode || !state.dataSuspended) {
    return refuse(state, "data cache mode requires suspended data cache after instruction mode");
  }
  if (state.dataMode) return refuse(state, "data cache mode is already configured");
  const registers = state.registers;
  if (registers.dataControl1 !== 3 ||
      registers.dataAutoloadControl !== ESP32S3_DIRECT_APP_CACHE_REGISTERS.dataAutoloadControl ||
      registers.instructionControl1 !== ESP32S3_DIRECT_APP_CACHE_REGISTERS.instructionControl1 ||
      registers.instructionAutoloadControl !== ESP32S3_DIRECT_APP_CACHE_REGISTERS.instructionAutoloadControl ||
      registers.cacheState !== ESP32S3_DIRECT_APP_CACHE_REGISTERS.cacheState) {
    return refuse(state, "data cache mode requires observed suspended register state");
  }
  const expected = Object.values(ESP32S3_DIRECT_APP_DATA_CACHE_MODE);
  if (!sameArguments(invocation.arguments, expected)) {
    return refuse(state, `unexpected data cache mode arguments: expected ${expected.join(",")}`);
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    operation: "configure-data",
    returnValue: null,
    state: freezeState(
      state.sequenceIndex,
      state.registers,
      state.instructionMode,
      state.dataSuspended,
      ESP32S3_DIRECT_APP_DATA_CACHE_MODE,
    ),
  });
}
