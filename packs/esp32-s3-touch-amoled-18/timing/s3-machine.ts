import {
  AddressSpaceResolver,
  type AddressMapConfiguration,
  type AddressRegion,
  type ResolvedAddressSegment,
  type VirtualMemoryAccess,
} from "./address-map";
import type { CacheLatency } from "./cache";
import type { CoreId } from "./execution";

export const ESP32_S3_RESET_VECTOR = 0x4000_0400;
export const ESP32_S3_RESET_VECBASE = 0x4000_0000;
export const ESP32_S3_ROM_BOOT_STACK_TOP = 0x3fce_b710;

export const ESP32_S3_VECTOR_OFFSETS = Object.freeze({
  level2: 0x180,
  level3: 0x1c0,
  level4: 0x200,
  level5: 0x240,
  level6: 0x280,
  level7: 0x2c0,
  kernelException: 0x300,
  userException: 0x340,
  doubleException: 0x3c0,
});

export const ESP32_S3_INTERRUPT_SOURCE_COUNT = 99;
export const ESP32_S3_DISABLED_CPU_INTERRUPT = 6;
export const ESP32_S3_INTERRUPT_MAP_DEFAULT = 16;
export const ESP32_S3_INTERRUPT_MAP_MASK = 0x1f;

export const ESP32_S3_MMIO = Object.freeze({
  interruptCore0MapBase: 0x600c_2000,
  interruptCore1MapBase: 0x600c_2800,
  extmemDcacheCtrl1: 0x600c_4004,
  extmemIcacheCtrl1: 0x600c_4064,
  assistDebugCore1PdebugEnable: 0x600c_e0d8,
  assistDebugCore1Recording: 0x600c_e0dc,
});

export interface Esp32S3MachineSource {
  readonly path: string;
  readonly symbols: readonly string[];
  readonly url: string;
}

const IDF_V6_0_2 = "https://github.com/espressif/esp-idf/blob/v6.0.2/";

export const ESP32_S3_IDF_V6_0_2_MACHINE_SOURCES: readonly Esp32S3MachineSource[] =
  Object.freeze([
    Object.freeze({
      path: "components/xtensa/esp32s3/include/xtensa/config/core-isa.h",
      symbols: Object.freeze([
        "XCHAL_VECBASE_RESET_VADDR",
        "XCHAL_RESET_VECTOR_VADDR",
        "XCHAL_USER_VECTOR_VADDR",
        "XCHAL_KERNEL_VECTOR_VADDR",
        "XCHAL_DOUBLEEXC_VECTOR_VADDR",
        "XCHAL_INTLEVEL2_VECTOR_VADDR",
        "XCHAL_INTLEVEL3_VECTOR_VADDR",
        "XCHAL_INTLEVEL4_VECTOR_VADDR",
        "XCHAL_INTLEVEL5_VECTOR_VADDR",
        "XCHAL_INTLEVEL6_VECTOR_VADDR",
        "XCHAL_INTLEVEL7_VECTOR_VADDR",
        "XCHAL_INT0_LEVEL through XCHAL_INT31_LEVEL",
      ]),
      url: `${IDF_V6_0_2}components/xtensa/esp32s3/include/xtensa/config/core-isa.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/register/soc/reg_base.h",
      symbols: Object.freeze([
        "DR_REG_INTERRUPT_BASE",
        "DR_REG_EXTMEM_BASE",
        "DR_REG_ASSIST_DEBUG_BASE",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/register/soc/reg_base.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/register/soc/interrupt_core0_reg.h",
      symbols: Object.freeze([
        "INTERRUPT_CORE0_MAC_INTR_MAP_REG",
        "INTERRUPT_CORE0_DMA_EXTMEM_REJECT_INT_MAP_REG",
        "INTERRUPT_CORE0_*_MAP",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/register/soc/interrupt_core0_reg.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/register/soc/interrupt_core1_reg.h",
      symbols: Object.freeze([
        "INTERRUPT_CORE1_MAC_INTR_MAP_REG",
        "INTERRUPT_CORE1_DMA_EXTMEM_REJECT_INT_MAP_REG",
        "INTERRUPT_CORE1_*_MAP",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/register/soc/interrupt_core1_reg.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/include/soc/interrupts.h",
      symbols: Object.freeze(["ETS_MAX_INTR_SOURCE"]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/include/soc/interrupts.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/include/soc/soc.h",
      symbols: Object.freeze([
        "PRO_CPU_NUM",
        "APP_CPU_NUM",
        "SOC_ROM_STACK_START",
        "ETS_INVALID_INUM",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/include/soc/soc.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/register/soc/extmem_reg.h",
      symbols: Object.freeze([
        "EXTMEM_DCACHE_CTRL1_REG",
        "EXTMEM_DCACHE_SHUT_CORE0_BUS",
        "EXTMEM_DCACHE_SHUT_CORE1_BUS",
        "EXTMEM_ICACHE_CTRL1_REG",
        "EXTMEM_ICACHE_SHUT_CORE0_BUS",
        "EXTMEM_ICACHE_SHUT_CORE1_BUS",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/register/soc/extmem_reg.h`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/register/soc/assist_debug_reg.h",
      symbols: Object.freeze([
        "ASSIST_DEBUG_CORE_1_RCD_PDEBUGENABLE_REG",
        "ASSIST_DEBUG_CORE_1_RCD_RECORDING_REG",
      ]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/register/soc/assist_debug_reg.h`,
    }),
    Object.freeze({
      path: "components/esp_rom/include/esp_rom_sys.h",
      symbols: Object.freeze(["esp_rom_route_intr_matrix", "esp_rom_get_reset_reason"]),
      url: `${IDF_V6_0_2}components/esp_rom/include/esp_rom_sys.h`,
    }),
    Object.freeze({
      path: "components/esp_rom/esp32s3/ld/esp32s3.rom.ld",
      symbols: Object.freeze(["rtc_get_reset_reason = 0x4000057c"]),
      url: `${IDF_V6_0_2}components/esp_rom/esp32s3/ld/esp32s3.rom.ld`,
    }),
    Object.freeze({
      path: "components/esp_rom/esp32s3/ld/esp32s3.rom.api.ld",
      symbols: Object.freeze(["esp_rom_get_reset_reason = rtc_get_reset_reason"]),
      url: `${IDF_V6_0_2}components/esp_rom/esp32s3/ld/esp32s3.rom.api.ld`,
    }),
    Object.freeze({
      path: "components/esp_rom/linux/esp_rom_sys.c",
      symbols: Object.freeze(["esp_rom_get_reset_reason", "RESET_REASON_CHIP_POWER_ON"]),
      url: `${IDF_V6_0_2}components/esp_rom/linux/esp_rom_sys.c`,
    }),
    Object.freeze({
      path: "components/soc/esp32s3/include/soc/reset_reasons.h",
      symbols: Object.freeze(["RESET_REASON_CHIP_POWER_ON = 0x01"]),
      url: `${IDF_V6_0_2}components/soc/esp32s3/include/soc/reset_reasons.h`,
    }),
    Object.freeze({
      path: "components/esp_system/port/cpu_start.c",
      symbols: Object.freeze(["core_intr_matrix_clear"]),
      url: `${IDF_V6_0_2}components/esp_system/port/cpu_start.c`,
    }),
  ]);

// Generated ESP32-S3 Xtensa configuration, XCHAL_INT0_LEVEL through
// XCHAL_INT31_LEVEL. These are CPU interrupt levels, not peripheral sources.
export const ESP32_S3_CPU_INTERRUPT_LEVELS: readonly number[] = Object.freeze([
  1, 1, 1, 1, 1, 1, 1, 1,
  1, 1, 1, 3, 1, 1, 7, 3,
  5, 1, 1, 2, 2, 2, 3, 3,
  4, 4, 5, 3, 4, 3, 4, 5,
]);

export type Esp32S3RefusalCode =
  | "unsupported-mmio"
  | "unsupported-width"
  | "unaligned-mmio"
  | "invalid-interrupt-source"
  | "interrupt-arbitration-unsourced";

export class Esp32S3MachineRefusal extends Error {
  constructor(
    readonly code: Esp32S3RefusalCode,
    message: string,
    readonly detail: Readonly<Record<string, number | string | boolean>> = Object.freeze({}),
  ) {
    super(message);
    this.name = "Esp32S3MachineRefusal";
  }
}

export interface Esp32S3CoreState {
  readonly core: CoreId;
  readonly pc: number;
  readonly vecbase: number;
  readonly start: "reset-vector" | "elf-entry" | "explicit-entry";
  readonly stackPointer: number | null;
}

export interface Esp32S3MachineSnapshot {
  readonly schemaVersion: 1;
  readonly idfVersion: "v6.0.2";
  readonly architectureCalibration: "uncalibrated";
  readonly cycleAccurate: false;
  readonly cores: readonly [Esp32S3CoreState, Esp32S3CoreState];
  readonly interruptMap: readonly [readonly number[], readonly number[]];
  readonly assertedSources: readonly number[];
  readonly registers: Readonly<{
    extmemDcacheCtrl1: number;
    extmemIcacheCtrl1: number;
    assistDebugCore1PdebugEnable: number;
    assistDebugCore1Recording: number;
  }>;
}

export type Esp32S3ExceptionClass = "user" | "kernel" | "double";

export interface Esp32S3ExceptionDelivery {
  readonly kind: "exception";
  readonly core: CoreId;
  readonly exceptionClass: Esp32S3ExceptionClass;
  readonly cause: number;
  readonly faultPc: number;
  readonly faultAddress: number | null;
  readonly vector: number;
  readonly source: Esp32S3MachineSource;
}

export interface Esp32S3InterruptDelivery {
  readonly kind: "interrupt";
  readonly core: CoreId;
  readonly sources: readonly number[];
  readonly cpuInterrupt: number;
  readonly level: number;
  readonly interruptedPc: number;
  readonly vector: number;
  readonly level1ExceptionCause: 4 | null;
  readonly source: Esp32S3MachineSource;
}

function requireUint32(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > 0xffff_ffff) {
    throw new Error(`${path} must be an unsigned 32-bit integer`);
  }
  return value as number;
}

function requireCore(value: unknown): CoreId {
  if (value !== 0 && value !== 1) throw new Error("core must be 0 or 1");
  return value;
}

function requireInterruptSource(value: unknown): number {
  if (
    !Number.isSafeInteger(value) ||
    (value as number) < 0 ||
    (value as number) >= ESP32_S3_INTERRUPT_SOURCE_COUNT
  ) {
    throw new Esp32S3MachineRefusal(
      "invalid-interrupt-source",
      `interrupt source must be an integer from 0 through ${ESP32_S3_INTERRUPT_SOURCE_COUNT - 1}`,
      { source: typeof value === "number" ? value : String(value) },
    );
  }
  return value as number;
}

function vectorForLevel(vecbase: number, level: number): number {
  if (level === 1) return vecbase + ESP32_S3_VECTOR_OFFSETS.userException;
  const offset = ESP32_S3_VECTOR_OFFSETS[`level${level}` as keyof typeof ESP32_S3_VECTOR_OFFSETS];
  if (typeof offset !== "number" || level < 2 || level > 7) {
    throw new Error(`unsupported ESP32-S3 interrupt level ${level}`);
  }
  return vecbase + offset;
}

function machineSource(path: string): Esp32S3MachineSource {
  const source = ESP32_S3_IDF_V6_0_2_MACHINE_SOURCES.find((candidate) => candidate.path === path);
  if (!source) throw new Error(`internal error: missing machine source ${path}`);
  return source;
}

/**
 * Small stateful boundary for the reset, vector-routing, and MMIO behavior
 * reached by ESP-IDF's early ESP32-S3 app entry. It intentionally has no ROM,
 * timer, UART, GPIO, cache-control, or peripheral fallback.
 */
export class Esp32S3MachineSkeleton {
  #cores: [Esp32S3CoreState, Esp32S3CoreState];
  readonly #interruptMap: [number[], number[]];
  readonly #assertedSources = new Set<number>();
  #extmemDcacheCtrl1 = 3;
  #extmemIcacheCtrl1 = 3;
  #assistDebugCore1PdebugEnable = 0;
  #assistDebugCore1Recording = 0;

  constructor() {
    this.#cores = [this.#resetCore(0), this.#resetCore(1)];
    this.#interruptMap = [
      Array<number>(ESP32_S3_INTERRUPT_SOURCE_COUNT).fill(ESP32_S3_INTERRUPT_MAP_DEFAULT),
      Array<number>(ESP32_S3_INTERRUPT_SOURCE_COUNT).fill(ESP32_S3_INTERRUPT_MAP_DEFAULT),
    ];
  }

  #resetCore(core: CoreId): Esp32S3CoreState {
    return Object.freeze({
      core,
      pc: ESP32_S3_RESET_VECTOR,
      vecbase: ESP32_S3_RESET_VECBASE,
      start: "reset-vector" as const,
      stackPointer: null,
    });
  }

  reset(): Esp32S3MachineSnapshot {
    this.#cores = [this.#resetCore(0), this.#resetCore(1)];
    for (const map of this.#interruptMap) map.fill(ESP32_S3_INTERRUPT_MAP_DEFAULT);
    this.#assertedSources.clear();
    this.#extmemDcacheCtrl1 = 3;
    this.#extmemIcacheCtrl1 = 3;
    this.#assistDebugCore1PdebugEnable = 0;
    this.#assistDebugCore1Recording = 0;
    return this.snapshot();
  }

  startElf(coreValue: CoreId, entryValue: number): Esp32S3CoreState {
    const core = requireCore(coreValue);
    const entry = requireUint32(entryValue, "entry");
    const state = Object.freeze({
      core,
      pc: entry,
      vecbase: this.#cores[core].vecbase,
      start: "elf-entry" as const,
      stackPointer: ESP32_S3_ROM_BOOT_STACK_TOP,
    });
    this.#cores[core] = state;
    return state;
  }

  setProgramCounter(coreValue: CoreId, pcValue: number): Esp32S3CoreState {
    const core = requireCore(coreValue);
    const pc = requireUint32(pcValue, "pc");
    const state = Object.freeze({ ...this.#cores[core], pc, start: "explicit-entry" as const });
    this.#cores[core] = state;
    return state;
  }

  setVectorBase(coreValue: CoreId, vecbaseValue: number): Esp32S3CoreState {
    const core = requireCore(coreValue);
    const vecbase = requireUint32(vecbaseValue, "vecbase");
    const state = Object.freeze({ ...this.#cores[core], vecbase });
    this.#cores[core] = state;
    return state;
  }

  routeException(input: Readonly<{
    core: CoreId;
    exceptionClass: Esp32S3ExceptionClass;
    cause: number;
    faultPc: number;
    faultAddress?: number | null;
  }>): Esp32S3ExceptionDelivery {
    const core = requireCore(input.core);
    const cause = requireUint32(input.cause, "cause");
    const faultPc = requireUint32(input.faultPc, "faultPc");
    const faultAddress = input.faultAddress == null
      ? null
      : requireUint32(input.faultAddress, "faultAddress");
    const offset = input.exceptionClass === "user"
      ? ESP32_S3_VECTOR_OFFSETS.userException
      : input.exceptionClass === "kernel"
        ? ESP32_S3_VECTOR_OFFSETS.kernelException
        : input.exceptionClass === "double"
          ? ESP32_S3_VECTOR_OFFSETS.doubleException
          : null;
    if (offset === null) throw new Error("exceptionClass must be user, kernel, or double");
    return Object.freeze({
      kind: "exception",
      core,
      exceptionClass: input.exceptionClass,
      cause,
      faultPc,
      faultAddress,
      vector: this.#cores[core].vecbase + offset,
      source: machineSource("components/xtensa/esp32s3/include/xtensa/config/core-isa.h"),
    });
  }

  assertInterruptSource(sourceValue: number, asserted = true): void {
    const source = requireInterruptSource(sourceValue);
    if (asserted) this.#assertedSources.add(source);
    else this.#assertedSources.delete(source);
  }

  routePendingInterrupt(input: Readonly<{
    core: CoreId;
    enabledCpuInterruptMask: number;
    currentInterruptLevel: number;
  }>): Esp32S3InterruptDelivery | null {
    const core = requireCore(input.core);
    const enabled = requireUint32(input.enabledCpuInterruptMask, "enabledCpuInterruptMask");
    if (!Number.isSafeInteger(input.currentInterruptLevel) || input.currentInterruptLevel < 0 || input.currentInterruptLevel > 7) {
      throw new Error("currentInterruptLevel must be an integer from 0 through 7");
    }

    const byCpuInterrupt = new Map<number, number[]>();
    for (const source of [...this.#assertedSources].sort((left, right) => left - right)) {
      const cpuInterrupt = this.#interruptMap[core][source]!;
      if (cpuInterrupt === ESP32_S3_DISABLED_CPU_INTERRUPT) continue;
      if ((enabled & (1 << cpuInterrupt)) === 0) continue;
      const level = ESP32_S3_CPU_INTERRUPT_LEVELS[cpuInterrupt]!;
      if (level <= input.currentInterruptLevel) continue;
      const sources = byCpuInterrupt.get(cpuInterrupt) ?? [];
      sources.push(source);
      byCpuInterrupt.set(cpuInterrupt, sources);
    }
    if (byCpuInterrupt.size === 0) return null;

    const candidates = [...byCpuInterrupt.entries()].map(([cpuInterrupt, sources]) => ({
      cpuInterrupt,
      sources,
      level: ESP32_S3_CPU_INTERRUPT_LEVELS[cpuInterrupt]!,
    }));
    const highestLevel = Math.max(...candidates.map((candidate) => candidate.level));
    const highest = candidates.filter((candidate) => candidate.level === highestLevel);
    if (highest.length !== 1) {
      throw new Esp32S3MachineRefusal(
        "interrupt-arbitration-unsourced",
        `multiple level ${highestLevel} CPU interrupt lines are pending; arbitration is not sourced by the pinned ESP-IDF headers`,
        { core, level: highestLevel, lines: highest.map((candidate) => candidate.cpuInterrupt).join(",") },
      );
    }
    const selected = highest[0]!;
    return Object.freeze({
      kind: "interrupt",
      core,
      sources: Object.freeze(selected.sources),
      cpuInterrupt: selected.cpuInterrupt,
      level: selected.level,
      interruptedPc: this.#cores[core].pc,
      vector: vectorForLevel(this.#cores[core].vecbase, selected.level),
      level1ExceptionCause: selected.level === 1 ? 4 : null,
      source: machineSource("components/xtensa/esp32s3/include/xtensa/config/core-isa.h"),
    });
  }

  #mappedInterruptRegister(address: number): { core: CoreId; source: number } | null {
    for (const core of [0, 1] as const) {
      const base = core === 0
        ? ESP32_S3_MMIO.interruptCore0MapBase
        : ESP32_S3_MMIO.interruptCore1MapBase;
      const offset = address - base;
      if (offset >= 0 && offset < ESP32_S3_INTERRUPT_SOURCE_COUNT * 4 && offset % 4 === 0) {
        return { core, source: offset / 4 };
      }
    }
    return null;
  }

  #validateMmioAccess(addressValue: number, width: number): number {
    const address = requireUint32(addressValue, "address");
    if (width !== 4) {
      throw new Esp32S3MachineRefusal(
        "unsupported-width",
        `MMIO width ${width} is not implemented; this skeleton only models exercised 32-bit accesses`,
        { address, width },
      );
    }
    if ((address & 3) !== 0) {
      throw new Esp32S3MachineRefusal(
        "unaligned-mmio",
        `unaligned 32-bit MMIO access at 0x${address.toString(16)}`,
        { address, width },
      );
    }
    return address;
  }

  readMmio(addressValue: number, width = 4): number {
    const address = this.#validateMmioAccess(addressValue, width);
    const interrupt = this.#mappedInterruptRegister(address);
    if (interrupt) return this.#interruptMap[interrupt.core][interrupt.source]!;
    switch (address) {
      case ESP32_S3_MMIO.extmemDcacheCtrl1:
        return this.#extmemDcacheCtrl1;
      case ESP32_S3_MMIO.extmemIcacheCtrl1:
        return this.#extmemIcacheCtrl1;
      case ESP32_S3_MMIO.assistDebugCore1PdebugEnable:
        return this.#assistDebugCore1PdebugEnable;
      case ESP32_S3_MMIO.assistDebugCore1Recording:
        return this.#assistDebugCore1Recording;
      default:
        throw new Esp32S3MachineRefusal(
          "unsupported-mmio",
          `unsupported ESP32-S3 MMIO read at 0x${address.toString(16)}`,
          { address, operation: "read", width },
        );
    }
  }

  writeMmio(addressValue: number, valueValue: number, width = 4): void {
    const address = this.#validateMmioAccess(addressValue, width);
    const value = requireUint32(valueValue, "value");
    const interrupt = this.#mappedInterruptRegister(address);
    if (interrupt) {
      this.#interruptMap[interrupt.core][interrupt.source] = value & ESP32_S3_INTERRUPT_MAP_MASK;
      return;
    }
    switch (address) {
      case ESP32_S3_MMIO.extmemDcacheCtrl1:
        this.#extmemDcacheCtrl1 = value & 3;
        return;
      case ESP32_S3_MMIO.extmemIcacheCtrl1:
        this.#extmemIcacheCtrl1 = value & 3;
        return;
      case ESP32_S3_MMIO.assistDebugCore1PdebugEnable:
        this.#assistDebugCore1PdebugEnable = value & 1;
        return;
      case ESP32_S3_MMIO.assistDebugCore1Recording:
        this.#assistDebugCore1Recording = value & 1;
        return;
      default:
        throw new Esp32S3MachineRefusal(
          "unsupported-mmio",
          `unsupported ESP32-S3 MMIO write at 0x${address.toString(16)}`,
          { address, operation: "write", value, width },
        );
    }
  }

  snapshot(): Esp32S3MachineSnapshot {
    return Object.freeze({
      schemaVersion: 1,
      idfVersion: "v6.0.2",
      architectureCalibration: "uncalibrated",
      cycleAccurate: false,
      cores: Object.freeze([
        Object.freeze({ ...this.#cores[0] }),
        Object.freeze({ ...this.#cores[1] }),
      ]) as Esp32S3MachineSnapshot["cores"],
      interruptMap: Object.freeze([
        Object.freeze([...this.#interruptMap[0]]),
        Object.freeze([...this.#interruptMap[1]]),
      ]) as Esp32S3MachineSnapshot["interruptMap"],
      assertedSources: Object.freeze([...this.#assertedSources].sort((left, right) => left - right)),
      registers: Object.freeze({
        extmemDcacheCtrl1: this.#extmemDcacheCtrl1,
        extmemIcacheCtrl1: this.#extmemIcacheCtrl1,
        assistDebugCore1PdebugEnable: this.#assistDebugCore1PdebugEnable,
        assistDebugCore1Recording: this.#assistDebugCore1Recording,
      }),
    });
  }
}

function mmioRegion(id: string, base: number, size: number, peripheral: string): AddressRegion {
  return Object.freeze({
    id,
    base: BigInt(base),
    size: BigInt(size),
    kind: "mmio",
    permissions: Object.freeze({ read: true, write: true, execute: false }),
    cacheability: "uncached",
    physical: Object.freeze({ backingId: `esp32-s3-${peripheral}`, offset: 0n }),
    peripheral,
  });
}

export const ESP32_S3_MACHINE_MMIO_REGIONS: readonly AddressRegion[] = Object.freeze([
  mmioRegion(
    "esp32-s3-interrupt-core0-map",
    ESP32_S3_MMIO.interruptCore0MapBase,
    ESP32_S3_INTERRUPT_SOURCE_COUNT * 4,
    "interrupt-core0-map",
  ),
  mmioRegion(
    "esp32-s3-interrupt-core1-map",
    ESP32_S3_MMIO.interruptCore1MapBase,
    ESP32_S3_INTERRUPT_SOURCE_COUNT * 4,
    "interrupt-core1-map",
  ),
  mmioRegion("esp32-s3-extmem-dcache-ctrl1", ESP32_S3_MMIO.extmemDcacheCtrl1, 4, "extmem"),
  mmioRegion("esp32-s3-extmem-icache-ctrl1", ESP32_S3_MMIO.extmemIcacheCtrl1, 4, "extmem"),
  mmioRegion(
    "esp32-s3-assist-debug-core1-pdebug-enable",
    ESP32_S3_MMIO.assistDebugCore1PdebugEnable,
    4,
    "assist-debug",
  ),
  mmioRegion(
    "esp32-s3-assist-debug-core1-recording",
    ESP32_S3_MMIO.assistDebugCore1Recording,
    4,
    "assist-debug",
  ),
]);

/** Add only the explicitly implemented boot MMIO registers to an address map. */
export function withEsp32S3MachineMmio(
  base: AddressMapConfiguration,
): AddressMapConfiguration {
  const result = Object.freeze({
    addressBits: base.addressBits,
    metadata: Object.freeze({
      architectureCalibration: "uncalibrated" as const,
      source: `${base.metadata.source}; ESP-IDF v6.0.2 ESP32-S3 machine MMIO`,
    }),
    regions: Object.freeze([...base.regions, ...ESP32_S3_MACHINE_MMIO_REGIONS]),
  });
  new AddressSpaceResolver(result);
  return result;
}

/** MMIO timing remains unknown until a hardware-backed cost is adopted. */
export function esp32S3MachineMmioCost(
  segment: ResolvedAddressSegment,
  access: VirtualMemoryAccess,
): CacheLatency {
  return Object.freeze({
    status: "unknown",
    reason: `no adopted ESP32-S3 MMIO cycle cost for ${segment.peripheral ?? segment.regionId} ${access.kind}`,
    source: "ESP-IDF v6.0.2 defines register behavior, not access latency",
  });
}
