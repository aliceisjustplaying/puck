export const ESP32S3_ROM_SET_CPU_TICKS_PER_US = 0x4000_1a4c;
export const ESP32S3_DIRECT_BOOT_CPU_TICKS_PER_US = 40;
export const ESP32S3_DIRECT_BOOT_CPU_TICKS_CALLINC = 2;

export const ESP32S3_DIRECT_BOOT_CPU_TICKS_PROVENANCE = Object.freeze({
  bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_XTAL_FREQ_40=y",
  source: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_xtal",
  rom: "ESP32-S3 ROM API esp_rom_set_cpu_ticks_per_us",
});

export interface Esp32S3DirectBootCpuTicksState {
  readonly configured: boolean;
  readonly ticksPerUs: number | null;
  readonly lastPc: number | null;
}

export interface Esp32S3DirectBootCpuTicksAccess {
  readonly pc: number;
  readonly callinc: number;
  readonly ticksPerUs: number;
  readonly systemSysclkReadCount: number;
  readonly systemCpuPerReadCount: number;
  readonly rtcReadCount: number;
}

export type Esp32S3DirectBootCpuTicksDispatch = Readonly<
  | { status: "refused"; reason: string; state: Esp32S3DirectBootCpuTicksState }
  | { status: "accepted"; state: Esp32S3DirectBootCpuTicksState }
>;

export function createEsp32S3DirectBootCpuTicks(): Esp32S3DirectBootCpuTicksState {
  return Object.freeze({ configured: false, ticksPerUs: null, lastPc: null });
}

export function configureEsp32S3DirectBootCpuTicks(
  state: Esp32S3DirectBootCpuTicksState,
  access: Esp32S3DirectBootCpuTicksAccess,
): Esp32S3DirectBootCpuTicksDispatch {
  const refuse = (reason: string): Esp32S3DirectBootCpuTicksDispatch =>
    Object.freeze({ status: "refused", reason, state });
  if (state.configured) return refuse("CPU ticks-per-us already configured");
  if (access.pc !== ESP32S3_ROM_SET_CPU_TICKS_PER_US) return refuse("unexpected CPU ticks ROM callback");
  if (access.callinc !== ESP32S3_DIRECT_BOOT_CPU_TICKS_CALLINC) return refuse("unexpected CPU ticks CALLINC");
  if (access.ticksPerUs !== ESP32S3_DIRECT_BOOT_CPU_TICKS_PER_US) return refuse("unexpected CPU ticks-per-us argument");
  if (access.systemSysclkReadCount !== 2 || access.systemCpuPerReadCount !== 4 || access.rtcReadCount !== 1) {
    return refuse("CPU ticks callback preceded the observed clock-query sequence");
  }
  return Object.freeze({
    status: "accepted",
    state: Object.freeze({ configured: true, ticksPerUs: access.ticksPerUs, lastPc: access.pc }),
  });
}
