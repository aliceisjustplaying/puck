export const ESP32S3_SYSTEM_MMIO_PAGE = 0x600c_0000;
export const ESP32S3_SYSTEM_CPU_PER_CONF_REG = 0x600c_0010;
export const ESP32S3_SYSTEM_SYSCLK_CONF_REG = 0x600c_0060;
export const ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC = 0x4037_71a5;
export const ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_READ_PC = 0x4037_7275;
export const ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_WRITE_PC = 0x4037_727d;
export const ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_READ_PC = 0x4037_7294;
export const ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_WRITE_PC = 0x4037_72a5;
export const ESP32S3_DIRECT_BOOT_SYSCLK_POST_ADJUST_READ_PC = 0x4037_72aa;
export const ESP32S3_DIRECT_BOOT_SYSCLK_XTAL_WRITE_PC = 0x4037_72b8;
export const ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC = 0x4037_71d6;
export const ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC = 0x4037_71ff;

/*
 * TinyDraw's ESP-IDF v6.0.2 bootloader config selects 80 MHz. The S3
 * bootloader clock path selects PLL (SOC_CLK_SEL=1) and divider 1
 * (PRE_DIV_CNT=0); system_reg.h defines every other reset field as zero.
 */
export const ESP32S3_DIRECT_BOOT_SYSCLK_CONF = 0x0000_0400;
/* 80 MHz CPUPERIOD_SEL=0, 480 MHz PLL_FREQ_SEL=1, WAIT_MODE_FORCE_ON=0. */
export const ESP32S3_DIRECT_BOOT_CPU_PER_CONF = 0x0000_0004;
export const ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE = Object.freeze({
  bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
  source: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_pll_mhz",
  register: "ESP-IDF v6.0.2 soc/esp32s3/register/soc/system_reg.h: SYSTEM_SYSCLK_CONF_REG",
});
export const ESP32S3_DIRECT_BOOT_CPU_PER_PROVENANCE = Object.freeze({
  bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
  clockSource: "ESP-IDF v6.0.2 esp_hal_clock/esp32s3/include/hal/clk_tree_ll.h: clk_ll_cpu_set_freq_mhz_from_pll",
  waitMode: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/include/soc/rtc.h + rtc_init.c: default cpu_waiti_clk_gate=1 clears WAIT_MODE_FORCE_ON",
  register: "ESP-IDF v6.0.2 soc/esp32s3/register/soc/system_reg.h: SYSTEM_CPU_PER_CONF_REG",
});

export interface Esp32S3DirectBootSystemMmioState {
  readonly sysclkConf: number;
  readonly readCount: number;
  readonly lastReadPc: number | null;
  readonly cpuPerConf: number;
  readonly cpuPerReadCount: number;
  readonly cpuPerLastReadPc: number | null;
  readonly writeCount: number;
  readonly lastWritePc: number | null;
}

export interface Esp32S3DirectBootSystemMmioAccess {
  readonly pc: number;
  readonly address: number;
  readonly width: number;
  readonly isWrite: boolean;
  readonly rtcMmioComplete: boolean;
  readonly cpuTicksConfigured?: boolean;
}

export type Esp32S3DirectBootSystemMmioDispatch =
  | Readonly<{ handled: false; status?: never }>
  | Readonly<{
      handled: true;
      status: "refused";
      reason: string;
      state: Esp32S3DirectBootSystemMmioState;
    }>
  | Readonly<{
      handled: true;
      status: "accepted";
      value: number;
      state: Esp32S3DirectBootSystemMmioState;
    }>;

export function createEsp32S3DirectBootSystemMmio(): Esp32S3DirectBootSystemMmioState {
  return Object.freeze({
    sysclkConf: ESP32S3_DIRECT_BOOT_SYSCLK_CONF,
    readCount: 0,
    lastReadPc: null,
    cpuPerConf: ESP32S3_DIRECT_BOOT_CPU_PER_CONF,
    cpuPerReadCount: 0,
    cpuPerLastReadPc: null,
    writeCount: 0,
    lastWritePc: null,
  });
}

export function writeEsp32S3DirectBootSystemMmio(
  state: Esp32S3DirectBootSystemMmioState,
  access: Esp32S3DirectBootSystemMmioAccess & Readonly<{ value: number }>,
): Esp32S3DirectBootSystemMmioDispatch {
  if ((access.address & ~0xfff) !== ESP32S3_SYSTEM_MMIO_PAGE) return Object.freeze({ handled: false });
  if (access.address !== ESP32S3_SYSTEM_SYSCLK_CONF_REG || access.width !== 4 || !access.isWrite) {
    return refuse(state, "only the observed aligned SYSTEM_SYSCLK_CONF write is declared");
  }
  if (state.writeCount >= 3) return refuse(state, "SYSTEM_SYSCLK_CONF direct-boot writes already occurred");
  const expectedPc = state.writeCount === 0
    ? ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_WRITE_PC
    : state.writeCount === 1
      ? ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_WRITE_PC
      : ESP32S3_DIRECT_BOOT_SYSCLK_XTAL_WRITE_PC;
  const expectedReadCount = state.writeCount + 3;
  const expectedValue = state.writeCount === 2 ? 0 : state.sysclkConf;
  if (access.pc !== expectedPc || access.value !== expectedValue ||
      !access.rtcMmioComplete || !access.cpuTicksConfigured ||
      state.readCount !== expectedReadCount || state.cpuPerReadCount !== 4) {
    return refuse(state, "SYSTEM_SYSCLK_CONF write violated the observed post-ticks contract");
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: access.value,
    state: Object.freeze({
      ...state,
      sysclkConf: access.value,
      writeCount: state.writeCount + 1,
      lastWritePc: access.pc,
    }),
  });
}

function refuse(
  state: Esp32S3DirectBootSystemMmioState,
  reason: string,
): Esp32S3DirectBootSystemMmioDispatch {
  return Object.freeze({ handled: true, status: "refused", reason, state });
}

export function readEsp32S3DirectBootSystemMmio(
  state: Esp32S3DirectBootSystemMmioState,
  access: Esp32S3DirectBootSystemMmioAccess,
): Esp32S3DirectBootSystemMmioDispatch {
  if ((access.address & ~0xfff) !== ESP32S3_SYSTEM_MMIO_PAGE) {
    return Object.freeze({ handled: false });
  }
  if (access.address === ESP32S3_SYSTEM_CPU_PER_CONF_REG) {
    if (access.width !== 4 || access.isWrite) {
      return refuse(state, "SYSTEM_CPU_PER_CONF permits only the observed aligned 32-bit read");
    }
    if (state.cpuPerReadCount >= 4) {
      return refuse(state, "SYSTEM_CPU_PER_CONF direct-boot reads already occurred");
    }
    if (access.cpuTicksConfigured) {
      return refuse(state, "SYSTEM_CPU_PER_CONF read followed CPU ticks configuration");
    }
    const repeatedSequence = state.cpuPerReadCount >= 2;
    if (repeatedSequence
      ? state.readCount !== 2 || !access.rtcMmioComplete
      : state.readCount !== 1 || access.rtcMmioComplete) {
      return refuse(state, "SYSTEM_CPU_PER_CONF read occurred outside its observed clock sequence");
    }
    const expectedPc = (state.cpuPerReadCount & 1) === 1
      ? ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC
      : ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC;
    if (access.pc !== expectedPc) {
      return refuse(state, `unexpected SYSTEM_CPU_PER_CONF reader 0x${access.pc.toString(16)}`);
    }
    return Object.freeze({
      handled: true,
      status: "accepted",
      value: state.cpuPerConf,
      state: Object.freeze({
        ...state,
        cpuPerReadCount: state.cpuPerReadCount + 1,
        cpuPerLastReadPc: access.pc,
      }),
    });
  }
  if (access.address !== ESP32S3_SYSTEM_SYSCLK_CONF_REG) {
    return refuse(state, `undeclared system MMIO register 0x${access.address.toString(16)}`);
  }
  if (access.width !== 4 || access.isWrite) {
    return refuse(state, "SYSTEM_SYSCLK_CONF permits only the observed aligned 32-bit read");
  }
  if (state.readCount >= 5) return refuse(state, "SYSTEM_SYSCLK_CONF direct-boot reads already occurred");
  const expectedPc = state.readCount === 4
    ? ESP32S3_DIRECT_BOOT_SYSCLK_POST_ADJUST_READ_PC
    : state.readCount === 3
      ? ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_READ_PC
      : state.readCount === 2
        ? ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_READ_PC
        : ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC;
  if (access.pc !== expectedPc) {
    return refuse(state, `unexpected SYSTEM_SYSCLK_CONF reader 0x${access.pc.toString(16)}`);
  }
  if (state.readCount === 0 && (access.rtcMmioComplete || access.cpuTicksConfigured)) {
    return refuse(state, "initial SYSTEM_SYSCLK_CONF read followed RTC_XTAL_FREQ");
  }
  if (state.readCount === 1 &&
      (!access.rtcMmioComplete || access.cpuTicksConfigured || state.cpuPerReadCount !== 2)) {
    return refuse(state, "repeated SYSTEM_SYSCLK_CONF read preceded RTC_XTAL_FREQ");
  }
  if (state.readCount === 2 &&
      (!access.rtcMmioComplete || !access.cpuTicksConfigured || state.cpuPerReadCount !== 4)) {
    return refuse(state, "post-ticks SYSTEM_SYSCLK_CONF read preceded CPU ticks configuration");
  }
  if (state.readCount === 3 &&
      (!access.rtcMmioComplete || !access.cpuTicksConfigured || state.cpuPerReadCount !== 4 ||
       state.writeCount !== 1)) {
    return refuse(state, "clock-adjust SYSTEM_SYSCLK_CONF read preceded the post-ticks write");
  }
  if (state.readCount === 4 &&
      (!access.rtcMmioComplete || !access.cpuTicksConfigured || state.cpuPerReadCount !== 4 ||
       state.writeCount !== 2)) {
    return refuse(state, "post-adjust SYSTEM_SYSCLK_CONF read preceded the second clock write");
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: state.sysclkConf,
    state: Object.freeze({
      ...state,
      readCount: state.readCount + 1,
      lastReadPc: access.pc,
    }),
  });
}
