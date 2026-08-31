import { describe, expect, test } from "bun:test";
import {
  ESP32S3_BBPLL_MODE_HF,
  ESP32S3_BBPLL_MODE_HF_480M,
  ESP32S3_I2C_BBPLL,
  ESP32S3_I2C_BBPLL_HOST_ID,
  ESP32S3_ROM_I2C_WRITE_REG,
  createEsp32S3DirectBootBbpllRom,
  writeEsp32S3DirectBootBbpllRom,
} from "./direct-boot-bbpll-rom";

describe("ESP32-S3 direct-boot BBPLL ROM write", () => {
  const access = {
    pc: ESP32S3_ROM_I2C_WRITE_REG,
    callinc: 2,
    block: ESP32S3_I2C_BBPLL,
    hostId: ESP32S3_I2C_BBPLL_HOST_ID,
    register: ESP32S3_BBPLL_MODE_HF,
    data: ESP32S3_BBPLL_MODE_HF_480M,
    currentIntlevel: 3,
    interruptLevelRestored: true,
    priorIntlevelRestoreCount: 1,
    priorWriteCount: 0,
  } as const;

  test("records the exact ESP-IDF 480 MHz BBPLL mode write", () => {
    expect(writeEsp32S3DirectBootBbpllRom(createEsp32S3DirectBootBbpllRom(), access)).toEqual({
      handled: true,
      status: "accepted",
      returnValue: 0,
      state: { modeHf: 0x6b, writeCount: 1, lastPc: 0x4000_5d60 },
    });
  });

  test("refuses wrong ABI arguments, order, and duplicate writes", () => {
    const initial = createEsp32S3DirectBootBbpllRom();
    for (const invalid of [
      { ...access, pc: 0x4000_5d6c },
      { ...access, callinc: 0 },
      { ...access, block: 0x67 },
      { ...access, hostId: 0 },
      { ...access, register: 3 },
      { ...access, data: 0x69 },
      { ...access, currentIntlevel: 0 },
      { ...access, interruptLevelRestored: false },
      { ...access, priorIntlevelRestoreCount: 0 },
      { ...access, priorWriteCount: 1 },
    ]) expect(writeEsp32S3DirectBootBbpllRom(initial, invalid).status).toBe("refused");
    const accepted = writeEsp32S3DirectBootBbpllRom(initial, access);
    if (accepted.status !== "accepted") throw new Error("BBPLL ROM write refused");
    expect(writeEsp32S3DirectBootBbpllRom(accepted.state, access).status).toBe("refused");
  });
});
