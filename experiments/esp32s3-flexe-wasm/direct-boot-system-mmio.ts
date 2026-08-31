export const ESP32S3_SYSTEM_MMIO_PAGE = 0x600c_0000;
export const ESP32S3_SYSTEM_SYSCLK_CONF_REG = 0x600c_0060;
export const ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC = 0x4037_71a5;

/*
 * TinyDraw's ESP-IDF v6.0.2 bootloader config selects 80 MHz. The S3
 * bootloader clock path selects PLL (SOC_CLK_SEL=1) and divider 1
 * (PRE_DIV_CNT=0); system_reg.h defines every other reset field as zero.
 */
export const ESP32S3_DIRECT_BOOT_SYSCLK_CONF = 0x0000_0400;
export const ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE = Object.freeze({
  bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
  source: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_pll_mhz",
  register: "ESP-IDF v6.0.2 soc/esp32s3/register/soc/system_reg.h: SYSTEM_SYSCLK_CONF_REG",
});

export interface Esp32S3DirectBootSystemMmioState {
  readonly sysclkConf: number;
  readonly readCount: number;
  readonly lastReadPc: number | null;
}

export interface Esp32S3DirectBootSystemMmioAccess {
  readonly pc: number;
  readonly address: number;
  readonly width: number;
  readonly isWrite: boolean;
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
  if (access.address !== ESP32S3_SYSTEM_SYSCLK_CONF_REG) {
    return refuse(state, `undeclared system MMIO register 0x${access.address.toString(16)}`);
  }
  if (access.width !== 4 || access.isWrite) {
    return refuse(state, "SYSTEM_SYSCLK_CONF permits only the observed aligned 32-bit read");
  }
  if (access.pc !== ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC) {
    return refuse(state, `unexpected SYSTEM_SYSCLK_CONF reader 0x${access.pc.toString(16)}`);
  }
  if (state.readCount !== 0) return refuse(state, "SYSTEM_SYSCLK_CONF direct-boot read already occurred");
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: state.sysclkConf,
    state: Object.freeze({
      sysclkConf: state.sysclkConf,
      readCount: 1,
      lastReadPc: access.pc,
    }),
  });
}
