import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
  ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
  ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
  ESP32S3_ROM_SET_INTLEVEL,
  createEsp32S3DirectBootIntlevel,
  restoreEsp32S3DirectBootIntlevel,
} from "./direct-boot-intlevel";

describe("ESP32-S3 direct-boot interrupt-level restore", () => {
  test("restores the exact PS.INTLEVEL saved by xPortInIsrContext", () => {
    const restored = restoreEsp32S3DirectBootIntlevel(createEsp32S3DirectBootIntlevel(), {
      pc: ESP32S3_ROM_SET_INTLEVEL,
      callinc: 2,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
      regi2cCalibrationStarted: true,
      bbpllModeWritten: false,
      bbpllReferenceDividerWritten: false,
    });
    expect(restored).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 1, lastPc: 0x4000_1c38 },
    });
  });

  test("refuses wrong PC, CALLINC, saved PS, state, and duplicate calls", () => {
    const initial = createEsp32S3DirectBootIntlevel();
    const access = {
      pc: ESP32S3_ROM_SET_INTLEVEL,
      callinc: 2,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
      regi2cCalibrationStarted: true,
      bbpllModeWritten: false,
      bbpllReferenceDividerWritten: false,
    } as const;
    for (const invalid of [
      { ...access, pc: 0x4000_1c34 },
      { ...access, callinc: 0 },
      { ...access, restorePs: 3 },
      { ...access, regi2cCalibrationStarted: false },
    ]) expect(restoreEsp32S3DirectBootIntlevel(initial, invalid).status).toBe("refused");
    const first = restoreEsp32S3DirectBootIntlevel(initial, access);
    if (!first.handled || first.status !== "accepted") throw new Error("intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(first.state, access).status).toBe("refused");
    const secondAccess = {
      ...access,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
      bbpllModeWritten: true,
    };
    const second = restoreEsp32S3DirectBootIntlevel(first.state, secondAccess);
    expect(second).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 3, restoreCount: 2, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (second.status !== "accepted") throw new Error("second intlevel restore refused");
    const thirdAccess = { ...secondAccess, restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS };
    const third = restoreEsp32S3DirectBootIntlevel(second.state, thirdAccess);
    expect(third).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 3, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (third.status !== "accepted") throw new Error("third intlevel restore refused");
    const fourth = restoreEsp32S3DirectBootIntlevel(third.state, thirdAccess);
    expect(fourth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 4, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (fourth.status !== "accepted") throw new Error("fourth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(fourth.state, thirdAccess).status).toBe("refused");
    const fifthAccess = {
      ...secondAccess,
      bbpllReferenceDividerWritten: true,
    };
    const fifth = restoreEsp32S3DirectBootIntlevel(fourth.state, fifthAccess);
    expect(fifth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 3, restoreCount: 5, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (fifth.status !== "accepted") throw new Error("fifth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(fifth.state, fifthAccess).status).toBe("refused");
    const sixthAccess = { ...fifthAccess, restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS };
    const sixth = restoreEsp32S3DirectBootIntlevel(fifth.state, sixthAccess);
    expect(sixth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 6, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (sixth.status !== "accepted") throw new Error("sixth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(sixth.state, sixthAccess).status).toBe("refused");
  });
});
