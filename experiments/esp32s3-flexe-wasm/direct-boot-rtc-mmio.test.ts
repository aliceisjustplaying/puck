import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ,
  ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
  ESP32S3_DIRECT_BOOT_RTC_XTAL_PROVENANCE,
  ESP32S3_RTC_CNTL_MMIO_PAGE,
  ESP32S3_RTC_XTAL_FREQ_REG,
  createEsp32S3DirectBootRtcMmio,
  readEsp32S3DirectBootRtcMmio,
} from "./direct-boot-rtc-mmio";

describe("ESP32-S3 direct-boot RTCCNTL MMIO", () => {
  test("reads the bootloader-persisted 40 MHz crystal frequency", () => {
    expect(ESP32S3_RTC_CNTL_MMIO_PAGE).toBe(0x6000_8000);
    expect(ESP32S3_RTC_XTAL_FREQ_REG).toBe(0x6000_80c0);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC).toBe(0x4037_7159);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ).toBe(0x0028_0028);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_XTAL_FREQ=40 and CONFIG_BOOT_ROM_LOG_ALWAYS_ON=1",
      store: "ESP-IDF v6.0.2 esp_hal_clock/esp32s3/include/hal/clk_tree_ll.h: clk_ll_xtal_store_freq_mhz",
      bootPath: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk_init.c: rtc_clk_init calls rtc_clk_xtal_freq_update",
      register: "ESP-IDF v6.0.2 esp32s3/rom/rtc.h: RTC_XTAL_FREQ_REG is RTC_CNTL_STORE4_REG",
    });
    const initial = createEsp32S3DirectBootRtcMmio();
    expect(readEsp32S3DirectBootRtcMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    })).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0028_0028,
      state: {
        xtalFreqReg: 0x0028_0028,
        readCount: 1,
        lastReadPc: 0x4037_7159,
      },
    });
  });

  test("refuses undeclared registers, invalid access shapes, order, readers, and repeats", () => {
    const initial = createEsp32S3DirectBootRtcMmio();
    const valid = {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    } as const;
    for (const invalid of [
      { ...valid, address: 0x6000_80c4 },
      { ...valid, address: 0x6000_80c1 },
      { ...valid, width: 1 },
      { ...valid, width: 2 },
      { ...valid, isWrite: true },
      { ...valid, systemMmioComplete: false },
      { ...valid, pc: 0x4037_7156 },
    ]) {
      const refused = readEsp32S3DirectBootRtcMmio(initial, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(initial);
    }
    expect(readEsp32S3DirectBootRtcMmio(initial, {
      ...valid,
      address: 0x600c_0010,
    })).toEqual({ handled: false });
    const accepted = readEsp32S3DirectBootRtcMmio(initial, valid);
    if (!accepted.handled || accepted.status !== "accepted") throw new Error("RTC read refused");
    const repeated = readEsp32S3DirectBootRtcMmio(accepted.state, valid);
    expect(repeated.status).toBe("refused");
    if (repeated.handled) expect(repeated.state).toBe(accepted.state);
  });
});
