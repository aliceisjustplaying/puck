import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0,
  ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0_PROVENANCE,
  ESP32S3_DIRECT_BOOT_I2C_MST_CAL_START_LOW,
  ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_READ_PC,
  ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_WRITE_PC,
  ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC,
  ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_WRITE_PC,
  ESP32S3_I2C_MST_ANA_CONF0_REG,
  createEsp32S3DirectBootRegi2cMmio,
  readEsp32S3DirectBootRegi2cMmio,
  writeEsp32S3DirectBootRegi2cMmio,
} from "./direct-boot-regi2c-mmio";

describe("ESP32-S3 direct-boot REGI2C MMIO", () => {
  test("executes the observed BBPLL calibration-start RMWs", () => {
    expect(ESP32S3_I2C_MST_ANA_CONF0_REG).toBe(0x6000_e040);
    expect(ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0).toBe(0x0100_0004);
    expect(ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0_PROVENANCE).toEqual({
      source: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_bbpll_configure",
      register: "ESP-IDF v6.1 soc/esp32s3/include/soc/regi2c_defs.h: I2C_MST_ANA_CONF0_REG",
      inheritedState: "prior bootloader calibration observed CAL_DONE then calibration_stop selected FORCE_HIGH",
    });
    const initial = createEsp32S3DirectBootRegi2cMmio();
    const firstRead = readEsp32S3DirectBootRegi2cMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_READ_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: false,
      clockRestoreComplete: true,
    });
    expect(firstRead).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0100_0004,
      state: { anaConf0: 0x0100_0004, readCount: 1, lastReadPc: 0x4037_d7f8, writeCount: 0, lastWritePc: null },
    });
    if (!firstRead.handled || firstRead.status !== "accepted") throw new Error("first REGI2C read refused");
    const clearWrite = writeEsp32S3DirectBootRegi2cMmio(firstRead.state, {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_WRITE_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: true,
      value: 0x0100_0000,
      clockRestoreComplete: true,
    });
    expect(clearWrite.status).toBe("accepted");
    if (!clearWrite.handled || clearWrite.status !== "accepted") throw new Error("REGI2C clear refused");
    const secondRead = readEsp32S3DirectBootRegi2cMmio(clearWrite.state, {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: false,
      clockRestoreComplete: true,
    });
    expect(secondRead.status).toBe("accepted");
    if (!secondRead.handled || secondRead.status !== "accepted") throw new Error("second REGI2C read refused");
    expect(secondRead.value).toBe(0x0100_0000);
    const setWrite = writeEsp32S3DirectBootRegi2cMmio(secondRead.state, {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_WRITE_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: true,
      value: ESP32S3_DIRECT_BOOT_I2C_MST_CAL_START_LOW,
      clockRestoreComplete: true,
    });
    expect(setWrite).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0100_0008,
      state: { anaConf0: 0x0100_0008, readCount: 2, lastReadPc: 0x4037_d807, writeCount: 2, lastWritePc: 0x4037_d811 },
    });
    if (!setWrite.handled || setWrite.status !== "accepted") throw new Error("REGI2C set refused");
    expect(readEsp32S3DirectBootRegi2cMmio(setWrite.state, {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: false,
      clockRestoreComplete: true,
    }).status).toBe("refused");
  });

  test("refuses undeclared registers, shapes, state, order, values, and repeats", () => {
    const initial = createEsp32S3DirectBootRegi2cMmio();
    const read = {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_READ_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: false,
      clockRestoreComplete: true,
    } as const;
    expect(readEsp32S3DirectBootRegi2cMmio(initial, { ...read, address: 0x6000_e044 }).status).toBe("refused");
    for (const invalid of [
      { ...read, width: 2 },
      { ...read, isWrite: true },
      { ...read, pc: 0x4037_d7f5 },
      { ...read, clockRestoreComplete: false },
    ]) expect(readEsp32S3DirectBootRegi2cMmio(initial, invalid).status).toBe("refused");
    const first = readEsp32S3DirectBootRegi2cMmio(initial, read);
    if (!first.handled || first.status !== "accepted") throw new Error("first read refused");
    const clear = {
      pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_WRITE_PC,
      address: ESP32S3_I2C_MST_ANA_CONF0_REG,
      width: 4,
      isWrite: true,
      value: 0x0100_0000,
      clockRestoreComplete: true,
    } as const;
    expect(readEsp32S3DirectBootRegi2cMmio(first.state, read).status).toBe("refused");
    expect(writeEsp32S3DirectBootRegi2cMmio(first.state, { ...clear, value: 0x0100_0004 }).status).toBe("refused");
    const cleared = writeEsp32S3DirectBootRegi2cMmio(first.state, clear);
    if (!cleared.handled || cleared.status !== "accepted") throw new Error("clear refused");
    expect(writeEsp32S3DirectBootRegi2cMmio(cleared.state, clear).status).toBe("refused");
    expect(readEsp32S3DirectBootRegi2cMmio(cleared.state, { ...read, pc: ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC }).status).toBe("accepted");
  });
});
