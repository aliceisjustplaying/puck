export const ESP32S3_RTC_CNTL_MMIO_PAGE = 0x6000_8000;
export const ESP32S3_RTC_XTAL_FREQ_REG = 0x6000_80c0;
export const ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC = 0x4037_7159;
export const ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ = 0x0028_0028;

export const ESP32S3_DIRECT_BOOT_RTC_XTAL_PROVENANCE = Object.freeze({
  bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_XTAL_FREQ=40 and CONFIG_BOOT_ROM_LOG_ALWAYS_ON=1",
  store: "ESP-IDF v6.0.2 esp_hal_clock/esp32s3/include/hal/clk_tree_ll.h: clk_ll_xtal_store_freq_mhz",
  bootPath: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk_init.c: rtc_clk_init calls rtc_clk_xtal_freq_update",
  register: "ESP-IDF v6.0.2 esp32s3/rom/rtc.h: RTC_XTAL_FREQ_REG is RTC_CNTL_STORE4_REG",
});

export interface Esp32S3DirectBootRtcMmioState {
  readonly xtalFreqReg: number;
  readonly readCount: number;
  readonly lastReadPc: number | null;
}

export interface Esp32S3DirectBootRtcMmioAccess {
  readonly pc: number;
  readonly address: number;
  readonly width: number;
  readonly isWrite: boolean;
  readonly systemMmioComplete: boolean;
}

export type Esp32S3DirectBootRtcMmioDispatch =
  | Readonly<{ handled: false; status?: never }>
  | Readonly<{
      handled: true;
      status: "refused";
      reason: string;
      state: Esp32S3DirectBootRtcMmioState;
    }>
  | Readonly<{
      handled: true;
      status: "accepted";
      value: number;
      state: Esp32S3DirectBootRtcMmioState;
    }>;

export function createEsp32S3DirectBootRtcMmio(): Esp32S3DirectBootRtcMmioState {
  return Object.freeze({
    xtalFreqReg: ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ,
    readCount: 0,
    lastReadPc: null,
  });
}

function refuse(
  state: Esp32S3DirectBootRtcMmioState,
  reason: string,
): Esp32S3DirectBootRtcMmioDispatch {
  return Object.freeze({ handled: true, status: "refused", reason, state });
}

export function readEsp32S3DirectBootRtcMmio(
  state: Esp32S3DirectBootRtcMmioState,
  access: Esp32S3DirectBootRtcMmioAccess,
): Esp32S3DirectBootRtcMmioDispatch {
  if ((access.address & ~0xfff) !== ESP32S3_RTC_CNTL_MMIO_PAGE) {
    return Object.freeze({ handled: false });
  }
  if (access.address !== ESP32S3_RTC_XTAL_FREQ_REG) {
    return refuse(state, `undeclared RTCCNTL MMIO register 0x${access.address.toString(16)}`);
  }
  if (access.width !== 4 || access.isWrite) {
    return refuse(state, "RTC_XTAL_FREQ_REG permits only the observed aligned 32-bit read");
  }
  if (!access.systemMmioComplete) {
    return refuse(state, "RTC_XTAL_FREQ_REG read preceded SYSTEM clock reads");
  }
  if (access.pc !== ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC) {
    return refuse(state, `unexpected RTC_XTAL_FREQ_REG reader 0x${access.pc.toString(16)}`);
  }
  if (state.readCount !== 0) return refuse(state, "RTC_XTAL_FREQ_REG direct-boot read already occurred");
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: state.xtalFreqReg,
    state: Object.freeze({
      ...state,
      readCount: 1,
      lastReadPc: access.pc,
    }),
  });
}
