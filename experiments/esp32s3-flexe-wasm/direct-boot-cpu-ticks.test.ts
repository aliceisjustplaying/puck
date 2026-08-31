import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_CPU_TICKS_CALLINC,
  ESP32S3_DIRECT_BOOT_CPU_TICKS_PER_US,
  ESP32S3_DIRECT_BOOT_CPU_TICKS_PROVENANCE,
  ESP32S3_ROM_SET_CPU_TICKS_PER_US,
  configureEsp32S3DirectBootCpuTicks,
  createEsp32S3DirectBootCpuTicks,
} from "./direct-boot-cpu-ticks";

describe("ESP32-S3 direct-boot CPU ticks ROM callback", () => {
  const valid = Object.freeze({
    pc: ESP32S3_ROM_SET_CPU_TICKS_PER_US,
    callinc: ESP32S3_DIRECT_BOOT_CPU_TICKS_CALLINC,
    ticksPerUs: ESP32S3_DIRECT_BOOT_CPU_TICKS_PER_US,
    systemSysclkReadCount: 2,
    systemCpuPerReadCount: 4,
    rtcReadCount: 1,
  });

  test("accepts the observed 40 MHz callback after both clock-query cycles", () => {
    expect(ESP32S3_DIRECT_BOOT_CPU_TICKS_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_XTAL_FREQ_40=y",
      source: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_xtal",
      rom: "ESP32-S3 ROM API esp_rom_set_cpu_ticks_per_us",
    });
    expect(configureEsp32S3DirectBootCpuTicks(createEsp32S3DirectBootCpuTicks(), valid)).toEqual({
      status: "accepted",
      state: { configured: true, ticksPerUs: 40, lastPc: 0x4000_1a4c },
    });
  });

  test("refuses wrong arguments, state, caller shape, order, and repeats without mutation", () => {
    const initial = createEsp32S3DirectBootCpuTicks();
    for (const invalid of [
      { ...valid, pc: 0x4000_1a48 },
      { ...valid, callinc: 0 },
      { ...valid, callinc: 1 },
      { ...valid, ticksPerUs: 39 },
      { ...valid, ticksPerUs: 80 },
      { ...valid, systemSysclkReadCount: 1 },
      { ...valid, systemCpuPerReadCount: 3 },
      { ...valid, rtcReadCount: 0 },
    ]) {
      const refused = configureEsp32S3DirectBootCpuTicks(initial, invalid);
      expect(refused.status).toBe("refused");
      expect(refused.state).toBe(initial);
    }
    const accepted = configureEsp32S3DirectBootCpuTicks(initial, valid);
    if (accepted.status !== "accepted") throw new Error("CPU ticks callback refused");
    const repeated = configureEsp32S3DirectBootCpuTicks(accepted.state, valid);
    expect(repeated.status).toBe("refused");
    expect(repeated.state).toBe(accepted.state);
  });
});
