import { describe, expect, test } from "bun:test";
import type { AddressMapConfiguration } from "./address-map";
import { AddressSpaceResolver } from "./address-map";
import {
  ESP32_S3_CPU_INTERRUPT_LEVELS,
  ESP32_S3_DISABLED_CPU_INTERRUPT,
  ESP32_S3_IDF_V6_0_2_MACHINE_SOURCES,
  ESP32_S3_INTERRUPT_MAP_DEFAULT,
  ESP32_S3_INTERRUPT_SOURCE_COUNT,
  ESP32_S3_MMIO,
  ESP32_S3_RESET_VECBASE,
  ESP32_S3_RESET_VECTOR,
  ESP32_S3_ROM_BOOT_STACK_TOP,
  ESP32_S3_VECTOR_OFFSETS,
  Esp32S3MachineRefusal,
  Esp32S3MachineSkeleton,
  esp32S3MachineMmioCost,
  withEsp32S3MachineMmio,
} from "./s3-machine";

function baseAddressMap(): AddressMapConfiguration {
  return {
    addressBits: 32,
    metadata: {
      architectureCalibration: "uncalibrated",
      source: "synthetic-base-map",
    },
    regions: [
      {
        id: "iram",
        base: 0x4037_0000n,
        size: 0x7_0000n,
        kind: "sram",
        permissions: { read: true, write: true, execute: true },
        cacheability: "uncached",
        physical: { backingId: "internal-sram", offset: 0n },
      },
    ],
  };
}

describe("reset and ELF entry", () => {
  test("uses the generated ESP32-S3 reset vector and VECBASE values", () => {
    const machine = new Esp32S3MachineSkeleton();
    expect(machine.snapshot()).toMatchObject({
      schemaVersion: 1,
      idfVersion: "v6.0.2",
      architectureCalibration: "uncalibrated",
      cycleAccurate: false,
      cores: [
        { core: 0, pc: ESP32_S3_RESET_VECTOR, vecbase: ESP32_S3_RESET_VECBASE, start: "reset-vector" },
        { core: 1, pc: ESP32_S3_RESET_VECTOR, vecbase: ESP32_S3_RESET_VECBASE, start: "reset-vector" },
      ],
    });
    expect(machine.snapshot().interruptMap[0]).toHaveLength(ESP32_S3_INTERRUPT_SOURCE_COUNT);
    expect(machine.snapshot().interruptMap[0].every((value) => value === ESP32_S3_INTERRUPT_MAP_DEFAULT)).toBe(true);
  });

  test("starts a real ELF entry with the documented early ROM stack top", () => {
    const machine = new Esp32S3MachineSkeleton();
    expect(machine.startElf(0, 0x4037_5a54)).toEqual({
      core: 0,
      pc: 0x4037_5a54,
      vecbase: ESP32_S3_RESET_VECBASE,
      start: "elf-entry",
      stackPointer: ESP32_S3_ROM_BOOT_STACK_TOP,
    });
    machine.setVectorBase(0, 0x4037_4000);
    expect(machine.snapshot().cores[0].vecbase).toBe(0x4037_4000);
    expect(machine.reset().cores[0]).toMatchObject({
      pc: ESP32_S3_RESET_VECTOR,
      vecbase: ESP32_S3_RESET_VECBASE,
      stackPointer: null,
    });
  });
});

describe("exception and interrupt routing", () => {
  test("routes user, kernel, and double exceptions from the active VECBASE", () => {
    const machine = new Esp32S3MachineSkeleton();
    machine.setVectorBase(0, 0x4037_4000);
    expect(machine.routeException({
      core: 0,
      exceptionClass: "user",
      cause: 9,
      faultPc: 0x4200_1000,
      faultAddress: 0x3c00_0001,
    })).toMatchObject({
      kind: "exception",
      vector: 0x4037_4340,
      cause: 9,
      faultPc: 0x4200_1000,
      faultAddress: 0x3c00_0001,
    });
    expect(machine.routeException({
      core: 0,
      exceptionClass: "kernel",
      cause: 0,
      faultPc: 0x4037_5000,
    }).vector).toBe(0x4037_4000 + ESP32_S3_VECTOR_OFFSETS.kernelException);
    expect(machine.routeException({
      core: 0,
      exceptionClass: "double",
      cause: 0,
      faultPc: 0x4037_5000,
    }).vector).toBe(0x4037_4000 + ESP32_S3_VECTOR_OFFSETS.doubleException);
  });

  test("routes an asserted source through the programmed CPU line and vector level", () => {
    const machine = new Esp32S3MachineSkeleton();
    machine.startElf(0, 0x4037_5a54);
    machine.setVectorBase(0, 0x4037_4000);
    const source = 59;
    const cpuInterrupt = 19;
    expect(ESP32_S3_CPU_INTERRUPT_LEVELS[cpuInterrupt]).toBe(2);
    machine.writeMmio(ESP32_S3_MMIO.interruptCore0MapBase + source * 4, cpuInterrupt);
    machine.assertInterruptSource(source);
    expect(machine.routePendingInterrupt({
      core: 0,
      enabledCpuInterruptMask: 1 << cpuInterrupt,
      currentInterruptLevel: 0,
    })).toEqual(expect.objectContaining({
      kind: "interrupt",
      core: 0,
      sources: [source],
      cpuInterrupt,
      level: 2,
      interruptedPc: 0x4037_5a54,
      vector: 0x4037_4180,
      level1ExceptionCause: null,
    }));
  });

  test("uses the user exception vector and cause 4 for a level-1 interrupt", () => {
    const machine = new Esp32S3MachineSkeleton();
    machine.setVectorBase(1, 0x4037_4000);
    machine.writeMmio(ESP32_S3_MMIO.interruptCore1MapBase, 5);
    machine.assertInterruptSource(0);
    expect(machine.routePendingInterrupt({
      core: 1,
      enabledCpuInterruptMask: 1 << 5,
      currentInterruptLevel: 0,
    })).toMatchObject({
      cpuInterrupt: 5,
      level: 1,
      vector: 0x4037_4340,
      level1ExceptionCause: 4,
    });
  });

  test("treats ESP-IDF's invalid line 6 as disabled and refuses unsourced ties", () => {
    const machine = new Esp32S3MachineSkeleton();
    machine.writeMmio(ESP32_S3_MMIO.interruptCore0MapBase, ESP32_S3_DISABLED_CPU_INTERRUPT);
    machine.assertInterruptSource(0);
    expect(machine.routePendingInterrupt({
      core: 0,
      enabledCpuInterruptMask: 0xffff_ffff,
      currentInterruptLevel: 0,
    })).toBeNull();

    machine.writeMmio(ESP32_S3_MMIO.interruptCore0MapBase, 19);
    machine.writeMmio(ESP32_S3_MMIO.interruptCore0MapBase + 4, 20);
    machine.assertInterruptSource(1);
    expect(() => machine.routePendingInterrupt({
      core: 0,
      enabledCpuInterruptMask: (1 << 19) | (1 << 20),
      currentInterruptLevel: 0,
    })).toThrow("arbitration is not sourced");
  });
});

describe("boot-path MMIO", () => {
  test("implements the interrupt matrix's 99 low-five-bit mapping registers", () => {
    const machine = new Esp32S3MachineSkeleton();
    const lastCore0 = ESP32_S3_MMIO.interruptCore0MapBase + (ESP32_S3_INTERRUPT_SOURCE_COUNT - 1) * 4;
    const lastCore1 = ESP32_S3_MMIO.interruptCore1MapBase + (ESP32_S3_INTERRUPT_SOURCE_COUNT - 1) * 4;
    expect(machine.readMmio(lastCore0)).toBe(16);
    expect(machine.readMmio(lastCore1)).toBe(16);
    machine.writeMmio(lastCore0, 0xffff_ffe3);
    machine.writeMmio(lastCore1, 28);
    expect(machine.readMmio(lastCore0)).toBe(3);
    expect(machine.readMmio(lastCore1)).toBe(28);
  });

  test("implements only the exercised EXTMEM shutdown and core-1 debug bits", () => {
    const machine = new Esp32S3MachineSkeleton();
    expect(machine.readMmio(ESP32_S3_MMIO.extmemDcacheCtrl1)).toBe(3);
    expect(machine.readMmio(ESP32_S3_MMIO.extmemIcacheCtrl1)).toBe(3);
    machine.writeMmio(ESP32_S3_MMIO.extmemDcacheCtrl1, 0xffff_fffe);
    machine.writeMmio(ESP32_S3_MMIO.extmemIcacheCtrl1, 0xffff_fffd);
    machine.writeMmio(ESP32_S3_MMIO.assistDebugCore1PdebugEnable, 3);
    machine.writeMmio(ESP32_S3_MMIO.assistDebugCore1Recording, 2);
    expect(machine.snapshot().registers).toEqual({
      extmemDcacheCtrl1: 2,
      extmemIcacheCtrl1: 1,
      assistDebugCore1PdebugEnable: 1,
      assistDebugCore1Recording: 0,
    });
  });

  test("refuses unsupported registers, widths, and unaligned addresses deterministically", () => {
    const machine = new Esp32S3MachineSkeleton();
    const attempts = [
      () => machine.readMmio(0x6000_0000),
      () => machine.writeMmio(0x6000_0000, 0),
      () => machine.readMmio(ESP32_S3_MMIO.extmemDcacheCtrl1, 1),
      () => machine.writeMmio(ESP32_S3_MMIO.extmemDcacheCtrl1 + 1, 0),
    ];
    expect(() => attempts[0]!()).toThrow(Esp32S3MachineRefusal);
    expect(() => attempts[0]!()).toThrow("unsupported ESP32-S3 MMIO read at 0x60000000");
    expect(() => attempts[1]!()).toThrow("unsupported ESP32-S3 MMIO write at 0x60000000");
    expect(() => attempts[2]!()).toThrow("only models exercised 32-bit accesses");
    expect(() => attempts[3]!()).toThrow("unaligned 32-bit MMIO access");
  });
});

describe("timing and address-map seams", () => {
  test("adds exact MMIO ranges to the existing resolver without adding a cost", () => {
    const config = withEsp32S3MachineMmio(baseAddressMap());
    const resolver = new AddressSpaceResolver(config);
    const resolved = resolver.resolve({
      id: "boot-extmem-read",
      core: 0,
      kind: "load",
      address: BigInt(ESP32_S3_MMIO.extmemDcacheCtrl1),
      bytes: 4,
    });
    expect(resolved).toMatchObject({
      status: "resolved",
      segments: [{ kind: "mmio", peripheral: "extmem" }],
    });
    if (resolved.status !== "resolved") throw new Error("expected resolved MMIO access");
    const cost = esp32S3MachineMmioCost(resolved.segments[0]!, resolved.access);
    expect(cost).toEqual({
      status: "unknown",
      reason: "no adopted ESP32-S3 MMIO cycle cost for extmem load",
      source: "ESP-IDF v6.0.2 defines register behavior, not access latency",
    });
  });

  test("pins exact official v6.0.2 source URLs", () => {
    expect(ESP32_S3_IDF_V6_0_2_MACHINE_SOURCES.length).toBeGreaterThanOrEqual(10);
    expect(ESP32_S3_IDF_V6_0_2_MACHINE_SOURCES.every((source) =>
      source.url.startsWith("https://github.com/espressif/esp-idf/blob/v6.0.2/") &&
      source.symbols.length > 0
    )).toBe(true);
  });
});
