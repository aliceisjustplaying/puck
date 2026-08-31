import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE,
  ESP32S3_DIRECT_APP_CACHE_REGISTERS,
  ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE,
  ESP32S3_CACHE_REGISTER_ADDRESSES,
  ESP32S3_ROM_CACHE_CALLBACKS,
  ESP32S3_ROM_CACHE_CALLINC,
  ESP32S3_ROM_CACHE_MODE_CALLBACKS,
  advanceEsp32S3DirectAppCacheBootstrap,
  configureEsp32S3DirectAppInstructionCache,
  createEsp32S3DirectAppCacheBootstrap,
  suspendEsp32S3DirectAppDataCache,
  type Esp32S3DirectAppCacheBootstrapState,
} from "./rom-cache-bootstrap";

function accepted(
  state: Esp32S3DirectAppCacheBootstrapState,
  pc: number,
  args: readonly number[] = [],
) {
  const result = advanceEsp32S3DirectAppCacheBootstrap(state, {
    pc,
    callinc: 2,
    arguments: args,
  });
  expect(result.handled).toBe(true);
  if (!result.handled || result.status !== "accepted") {
    throw new Error(result.handled ? result.reason : "callback was not handled");
  }
  return result;
}

describe("ESP32-S3 direct app cache bootstrap", () => {
  test("pins the ROM addresses and direct app-entry register contract", () => {
    expect(ESP32S3_ROM_CACHE_CALLBACKS).toEqual({
      disableInstruction: 0x4000_186c,
      enableInstruction: 0x4000_1878,
      disableData: 0x4000_1884,
      enableData: 0x4000_1890,
    });
    expect(ESP32S3_ROM_CACHE_CALLINC).toBe(2);
    expect(ESP32S3_CACHE_REGISTER_ADDRESSES).toEqual({
      dataControl1: 0x600c_4004,
      dataAutoloadControl: 0x600c_404c,
      instructionControl1: 0x600c_4064,
      instructionAutoloadControl: 0x600c_40a0,
      cacheState: 0x600c_4130,
    });
    expect(ESP32S3_DIRECT_APP_CACHE_REGISTERS).toEqual({
      dataControl1: 0,
      dataAutoloadControl: 8,
      instructionControl1: 0,
      instructionAutoloadControl: 8,
      cacheState: 0x0010_01,
    });
    expect(ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE.map((call) => call.pc)).toEqual([
      0x4000_186c,
      0x4000_1884,
      0x4000_1878,
      0x4000_1890,
      0x4000_1878,
      0x4000_1890,
    ]);
  });

  test("executes the observed disable, enable, and repeated-enable sequence", () => {
    let state = createEsp32S3DirectAppCacheBootstrap();
    expect(state.registers).toEqual(ESP32S3_DIRECT_APP_CACHE_REGISTERS);

    const disableInstruction = accepted(state, ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction);
    expect(disableInstruction.returnValue).toBe(0);
    expect(disableInstruction.state.registers).toEqual({
      ...ESP32S3_DIRECT_APP_CACHE_REGISTERS,
      instructionControl1: 1,
    });
    state = disableInstruction.state;

    const disableData = accepted(state, ESP32S3_ROM_CACHE_CALLBACKS.disableData);
    expect(disableData.returnValue).toBe(0);
    expect(disableData.state.registers).toEqual({
      ...ESP32S3_DIRECT_APP_CACHE_REGISTERS,
      instructionControl1: 1,
      dataControl1: 2,
    });
    state = disableData.state;

    const enableInstruction = accepted(
      state,
      ESP32S3_ROM_CACHE_CALLBACKS.enableInstruction,
      [0],
    );
    expect(enableInstruction.returnValue).toBeNull();
    expect(enableInstruction.state.registers.instructionControl1).toBe(0);
    expect(enableInstruction.state.registers.dataControl1).toBe(2);
    state = enableInstruction.state;

    const enableData = accepted(state, ESP32S3_ROM_CACHE_CALLBACKS.enableData, [0]);
    expect(enableData.state.registers).toEqual(ESP32S3_DIRECT_APP_CACHE_REGISTERS);
    state = enableData.state;

    state = accepted(state, ESP32S3_ROM_CACHE_CALLBACKS.enableInstruction, [0]).state;
    const complete = accepted(state, ESP32S3_ROM_CACHE_CALLBACKS.enableData, [0]);
    expect(complete.state.complete).toBe(true);
    expect(complete.state.sequenceIndex).toBe(ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE.length);
    expect(complete.state.registers).toEqual(ESP32S3_DIRECT_APP_CACHE_REGISTERS);
  });

  test("leaves state unchanged when callback order, CALLINC, or arguments are wrong", () => {
    const initial = createEsp32S3DirectAppCacheBootstrap();
    const invalid = [
      advanceEsp32S3DirectAppCacheBootstrap(initial, {
        pc: ESP32S3_ROM_CACHE_CALLBACKS.disableData,
        callinc: 2,
        arguments: [],
      }),
      advanceEsp32S3DirectAppCacheBootstrap(initial, {
        pc: ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction,
        callinc: 1,
        arguments: [],
      }),
      advanceEsp32S3DirectAppCacheBootstrap(initial, {
        pc: ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction,
        callinc: 2,
        arguments: [0],
      }),
    ];
    for (const result of invalid) {
      expect(result.handled).toBe(true);
      expect(result.status).toBe("refused");
      if (result.handled) expect(result.state).toBe(initial);
    }

    const afterDisables = accepted(
      accepted(initial, ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction).state,
      ESP32S3_ROM_CACHE_CALLBACKS.disableData,
    ).state;
    const invalidAutoload = advanceEsp32S3DirectAppCacheBootstrap(afterDisables, {
      pc: ESP32S3_ROM_CACHE_CALLBACKS.enableInstruction,
      callinc: 2,
      arguments: [4],
    });
    expect(invalidAutoload.handled).toBe(true);
    expect(invalidAutoload.status).toBe("refused");
    if (invalidAutoload.handled) expect(invalidAutoload.state).toBe(afterDisables);
  });

  test("does not claim unrelated ROM addresses", () => {
    const state = createEsp32S3DirectAppCacheBootstrap();
    expect(advanceEsp32S3DirectAppCacheBootstrap(state, {
      pc: 0x4000_189c,
      callinc: 2,
      arguments: [],
    })).toEqual({ handled: false });
  });

  test("refuses a callback unless both cache state fields report idle", () => {
    const initial = createEsp32S3DirectAppCacheBootstrap();
    const busy = Object.freeze({
      ...initial,
      registers: Object.freeze({ ...initial.registers, cacheState: 0x0010_02 }),
    });
    const result = advanceEsp32S3DirectAppCacheBootstrap(busy, {
      pc: ESP32S3_ROM_CACHE_CALLBACKS.disableInstruction,
      callinc: 2,
      arguments: [],
    });
    expect(result.handled).toBe(true);
    expect(result.status).toBe("refused");
    if (result.handled) {
      expect(result.state).toBe(busy);
      expect(result.status === "refused" ? result.reason : "").toContain("not idle");
    }
  });

  test("pins the instruction cache mode ROM contract", () => {
    expect(ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction).toBe(0x4000_1a1c);
    expect(ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE).toEqual({
      sizeBytes: 0x4000,
      ways: 8,
      lineBytes: 32,
    });
  });

  test("configures instruction cache geometry only after bootstrap completes", () => {
    let state = createEsp32S3DirectAppCacheBootstrap();
    for (const call of ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE) {
      state = accepted(state, call.pc, call.arguments).state;
    }
    const configured = configureEsp32S3DirectAppInstructionCache(state, {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [0x4000, 8, 32],
    });
    expect(configured.handled).toBe(true);
    expect(configured.status).toBe("accepted");
    if (configured.handled && configured.status === "accepted") {
      expect(configured.returnValue).toBeNull();
      expect(configured.state.instructionMode).toEqual(ESP32S3_DIRECT_APP_INSTRUCTION_CACHE_MODE);
      expect(configured.state.registers).toEqual(ESP32S3_DIRECT_APP_CACHE_REGISTERS);
    }
  });

  test("refuses early, repeated, or malformed instruction cache mode calls", () => {
    const initial = createEsp32S3DirectAppCacheBootstrap();
    const invocation = {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [0x4000, 8, 32],
    } as const;
    expect(configureEsp32S3DirectAppInstructionCache(initial, invocation).status).toBe("refused");

    let complete = initial;
    for (const call of ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE) {
      complete = accepted(complete, call.pc, call.arguments).state;
    }
    for (const malformed of [
      { ...invocation, callinc: 1 },
      { ...invocation, arguments: [0x8000, 8, 32] },
      { ...invocation, arguments: [0x4000, 4, 32] },
      { ...invocation, arguments: [0x4000, 8, 64] },
    ]) {
      const refused = configureEsp32S3DirectAppInstructionCache(complete, malformed);
      expect(refused.handled).toBe(true);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(complete);
    }

    const configured = configureEsp32S3DirectAppInstructionCache(complete, invocation);
    if (!configured.handled || configured.status !== "accepted") throw new Error("mode was refused");
    expect(configureEsp32S3DirectAppInstructionCache(configured.state, invocation).status).toBe("refused");
  });

  test("suspends data cache only after instruction cache mode configuration", () => {
    let state = createEsp32S3DirectAppCacheBootstrap();
    for (const call of ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE) {
      state = accepted(state, call.pc, call.arguments).state;
    }
    const configured = configureEsp32S3DirectAppInstructionCache(state, {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [0x4000, 8, 32],
    });
    if (!configured.handled || configured.status !== "accepted") throw new Error("mode was refused");

    const suspended = suspendEsp32S3DirectAppDataCache(configured.state, {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.suspendData,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [],
    });
    expect(suspended.handled).toBe(true);
    expect(suspended.status).toBe("accepted");
    if (suspended.handled && suspended.status === "accepted") {
      expect(suspended.returnValue).toBe(0);
      expect(suspended.state.dataSuspended).toBe(true);
      expect(suspended.state.registers.dataControl1).toBe(3);
      expect(suspended.state.registers.dataAutoloadControl).toBe(8);
    }
  });

  test("refuses early, repeated, argument-bearing, or wrong-CALLINC data suspension", () => {
    const initial = createEsp32S3DirectAppCacheBootstrap();
    const invocation = {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.suspendData,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [],
    } as const;
    expect(suspendEsp32S3DirectAppDataCache(initial, invocation).status).toBe("refused");

    let complete = initial;
    for (const call of ESP32S3_DIRECT_APP_CACHE_BOOTSTRAP_SEQUENCE) {
      complete = accepted(complete, call.pc, call.arguments).state;
    }
    const configured = configureEsp32S3DirectAppInstructionCache(complete, {
      pc: ESP32S3_ROM_CACHE_MODE_CALLBACKS.configureInstruction,
      callinc: ESP32S3_ROM_CACHE_CALLINC,
      arguments: [0x4000, 8, 32],
    });
    if (!configured.handled || configured.status !== "accepted") throw new Error("mode was refused");
    expect(suspendEsp32S3DirectAppDataCache(configured.state, { ...invocation, callinc: 1 }).status).toBe("refused");
    expect(suspendEsp32S3DirectAppDataCache(configured.state, { ...invocation, arguments: [0] }).status).toBe("refused");
    const suspended = suspendEsp32S3DirectAppDataCache(configured.state, invocation);
    if (!suspended.handled || suspended.status !== "accepted") throw new Error("suspend was refused");
    expect(suspendEsp32S3DirectAppDataCache(suspended.state, invocation).status).toBe("refused");
  });
});
