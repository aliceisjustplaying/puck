import { describe, expect, test } from "bun:test";
import {
  ESP32S3_BBPLL_MODE_HF,
  ESP32S3_BBPLL_MODE_HF_480M,
  ESP32S3_BBPLL_OC_DR1,
  ESP32S3_BBPLL_OC_DR1_LSB,
  ESP32S3_BBPLL_OC_DR1_MSB,
  ESP32S3_BBPLL_OC_DIV_7_0,
  ESP32S3_BBPLL_OC_DIV_7_0_480M,
  ESP32S3_BBPLL_OC_REF_DIV,
  ESP32S3_BBPLL_OC_REF_DIV_480M,
  ESP32S3_I2C_BBPLL,
  ESP32S3_I2C_BBPLL_HOST_ID,
  ESP32S3_ROM_I2C_WRITE_REG,
  ESP32S3_ROM_I2C_WRITE_REG_MASK,
  createEsp32S3DirectBootBbpllRom,
  writeEsp32S3DirectBootBbpllRom,
  writeEsp32S3DirectBootBbpllRomMask,
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
      state: { modeHf: 0x6b, refDiv: null, div7_0: null, dr1: null, writeCount: 1, maskedWriteCount: 0, lastPc: 0x4000_5d60 },
    });
  });

  test("records the following exact 40 MHz-reference divider write", () => {
    const mode = writeEsp32S3DirectBootBbpllRom(createEsp32S3DirectBootBbpllRom(), access);
    if (mode.status !== "accepted") throw new Error("BBPLL mode write refused");
    expect(writeEsp32S3DirectBootBbpllRom(mode.state, {
      ...access,
      register: ESP32S3_BBPLL_OC_REF_DIV,
      data: ESP32S3_BBPLL_OC_REF_DIV_480M,
      priorIntlevelRestoreCount: 4,
      priorWriteCount: 1,
    })).toEqual({
      handled: true,
      status: "accepted",
      returnValue: 0,
      state: { modeHf: 0x6b, refDiv: 0x50, div7_0: null, dr1: null, writeCount: 2, maskedWriteCount: 0, lastPc: 0x4000_5d60 },
    });
  });

  test("records the following exact 480 MHz divider write", () => {
    const mode = writeEsp32S3DirectBootBbpllRom(createEsp32S3DirectBootBbpllRom(), access);
    if (mode.status !== "accepted") throw new Error("BBPLL mode write refused");
    const referenceDivider = writeEsp32S3DirectBootBbpllRom(mode.state, {
      ...access,
      register: ESP32S3_BBPLL_OC_REF_DIV,
      data: ESP32S3_BBPLL_OC_REF_DIV_480M,
      priorIntlevelRestoreCount: 4,
      priorWriteCount: 1,
    });
    if (referenceDivider.status !== "accepted") throw new Error("BBPLL reference-divider write refused");
    expect(writeEsp32S3DirectBootBbpllRom(referenceDivider.state, {
      ...access,
      register: ESP32S3_BBPLL_OC_DIV_7_0,
      data: ESP32S3_BBPLL_OC_DIV_7_0_480M,
      priorIntlevelRestoreCount: 7,
      priorWriteCount: 2,
    })).toEqual({
      handled: true,
      status: "accepted",
      returnValue: 0,
      state: { modeHf: 0x6b, refDiv: 0x50, div7_0: 8, dr1: null, writeCount: 3, maskedWriteCount: 0, lastPc: 0x4000_5d60 },
    });
  });

  test("records the following exact 480 MHz DR1 masked write", () => {
    const mode = writeEsp32S3DirectBootBbpllRom(createEsp32S3DirectBootBbpllRom(), access);
    if (mode.status !== "accepted") throw new Error("BBPLL mode write refused");
    const referenceDivider = writeEsp32S3DirectBootBbpllRom(mode.state, {
      ...access,
      register: ESP32S3_BBPLL_OC_REF_DIV,
      data: ESP32S3_BBPLL_OC_REF_DIV_480M,
      priorIntlevelRestoreCount: 4,
      priorWriteCount: 1,
    });
    if (referenceDivider.status !== "accepted") throw new Error("BBPLL reference-divider write refused");
    const divider = writeEsp32S3DirectBootBbpllRom(referenceDivider.state, {
      ...access,
      register: ESP32S3_BBPLL_OC_DIV_7_0,
      data: ESP32S3_BBPLL_OC_DIV_7_0_480M,
      priorIntlevelRestoreCount: 7,
      priorWriteCount: 2,
    });
    if (divider.status !== "accepted") throw new Error("BBPLL divider write refused");
    const maskedAccess = {
      ...access,
      pc: ESP32S3_ROM_I2C_WRITE_REG_MASK,
      register: ESP32S3_BBPLL_OC_DR1,
      msb: ESP32S3_BBPLL_OC_DR1_MSB,
      lsb: ESP32S3_BBPLL_OC_DR1_LSB,
      data: 0,
      priorIntlevelRestoreCount: 10,
      priorWriteCount: 3,
      priorMaskedWriteCount: 0,
    } as const;
    expect(writeEsp32S3DirectBootBbpllRomMask(divider.state, maskedAccess)).toEqual({
      handled: true,
      status: "accepted",
      returnValue: 0,
      state: {
        modeHf: 0x6b,
        refDiv: 0x50,
        div7_0: 8,
        dr1: 0,
        writeCount: 3,
        maskedWriteCount: 1,
        lastPc: ESP32S3_ROM_I2C_WRITE_REG_MASK,
      },
    });
    for (const invalid of [
      { ...maskedAccess, pc: ESP32S3_ROM_I2C_WRITE_REG },
      { ...maskedAccess, callinc: 0 },
      { ...maskedAccess, register: 6 },
      { ...maskedAccess, msb: 3 },
      { ...maskedAccess, lsb: 1 },
      { ...maskedAccess, data: 1 },
      { ...maskedAccess, currentIntlevel: 0 },
      { ...maskedAccess, priorIntlevelRestoreCount: 9 },
      { ...maskedAccess, priorWriteCount: 2 },
      { ...maskedAccess, priorMaskedWriteCount: 1 },
    ]) expect(writeEsp32S3DirectBootBbpllRomMask(divider.state, invalid).status).toBe("refused");
    const masked = writeEsp32S3DirectBootBbpllRomMask(divider.state, maskedAccess);
    if (masked.status !== "accepted") throw new Error("BBPLL DR1 write refused");
    expect(writeEsp32S3DirectBootBbpllRomMask(masked.state, maskedAccess).status).toBe("refused");
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
    const refDiv = {
      ...access,
      register: ESP32S3_BBPLL_OC_REF_DIV,
      data: ESP32S3_BBPLL_OC_REF_DIV_480M,
      priorIntlevelRestoreCount: 4,
      priorWriteCount: 1,
    } as const;
    for (const invalid of [
      { ...refDiv, register: 3 },
      { ...refDiv, data: 0x51 },
      { ...refDiv, currentIntlevel: 0 },
      { ...refDiv, priorIntlevelRestoreCount: 3 },
      { ...refDiv, priorWriteCount: 0 },
    ]) expect(writeEsp32S3DirectBootBbpllRom(accepted.state, invalid).status).toBe("refused");
    const second = writeEsp32S3DirectBootBbpllRom(accepted.state, refDiv);
    if (second.status !== "accepted") throw new Error("BBPLL reference-divider write refused");
    expect(writeEsp32S3DirectBootBbpllRom(second.state, refDiv).status).toBe("refused");
    const divider = {
      ...access,
      register: ESP32S3_BBPLL_OC_DIV_7_0,
      data: ESP32S3_BBPLL_OC_DIV_7_0_480M,
      priorIntlevelRestoreCount: 7,
      priorWriteCount: 2,
    } as const;
    for (const invalid of [
      { ...divider, register: 6 },
      { ...divider, data: 4 },
      { ...divider, currentIntlevel: 0 },
      { ...divider, priorIntlevelRestoreCount: 6 },
      { ...divider, priorWriteCount: 1 },
    ]) expect(writeEsp32S3DirectBootBbpllRom(second.state, invalid).status).toBe("refused");
    const third = writeEsp32S3DirectBootBbpllRom(second.state, divider);
    if (third.status !== "accepted") throw new Error("BBPLL divider write refused");
    expect(writeEsp32S3DirectBootBbpllRom(third.state, divider).status).toBe("refused");
  });
});
