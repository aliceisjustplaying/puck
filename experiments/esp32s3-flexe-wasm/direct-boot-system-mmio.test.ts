import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_SYSCLK_CONF,
  ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE,
  ESP32S3_SYSTEM_MMIO_PAGE,
  ESP32S3_SYSTEM_SYSCLK_CONF_REG,
  createEsp32S3DirectBootSystemMmio,
  readEsp32S3DirectBootSystemMmio,
} from "./direct-boot-system-mmio";

describe("ESP32-S3 direct-boot system MMIO", () => {
  test("reads the bootloader-configured PLL source at the observed CPU clock probe", () => {
    expect(ESP32S3_SYSTEM_MMIO_PAGE).toBe(0x600c_0000);
    expect(ESP32S3_SYSTEM_SYSCLK_CONF_REG).toBe(0x600c_0060);
    expect(ESP32S3_DIRECT_BOOT_SYSCLK_CONF).toBe(0x0000_0400);
    expect(ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
      source: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_pll_mhz",
      register: "ESP-IDF v6.0.2 soc/esp32s3/register/soc/system_reg.h: SYSTEM_SYSCLK_CONF_REG",
    });
    const initial = createEsp32S3DirectBootSystemMmio();
    const read = readEsp32S3DirectBootSystemMmio(initial, {
      pc: 0x4037_71a5,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
    });
    expect(read).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0000_0400,
      state: {
        sysclkConf: 0x0000_0400,
        readCount: 1,
        lastReadPc: 0x4037_71a5,
      },
    });
  });

  test("refuses undeclared registers, invalid access shapes, readers, and repeats", () => {
    const initial = createEsp32S3DirectBootSystemMmio();
    const valid = {
      pc: 0x4037_71a5,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
    } as const;
    for (const invalid of [
      { ...valid, address: 0x600c_0064 },
      { ...valid, address: 0x600c_0061 },
      { ...valid, width: 1 },
      { ...valid, width: 2 },
      { ...valid, isWrite: true },
      { ...valid, pc: 0x4037_71a2 },
    ]) {
      const refused = readEsp32S3DirectBootSystemMmio(initial, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(initial);
    }
    expect(readEsp32S3DirectBootSystemMmio(initial, {
      ...valid,
      address: 0x600c_4004,
    })).toEqual({ handled: false });
    const accepted = readEsp32S3DirectBootSystemMmio(initial, valid);
    if (!accepted.handled || accepted.status !== "accepted") throw new Error("read refused");
    const repeated = readEsp32S3DirectBootSystemMmio(accepted.state, valid);
    expect(repeated.status).toBe("refused");
    if (repeated.handled) expect(repeated.state).toBe(accepted.state);
  });
});
