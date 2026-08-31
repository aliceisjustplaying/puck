import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
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
    } as const;
    for (const invalid of [
      { ...access, pc: 0x4000_1c34 },
      { ...access, callinc: 0 },
      { ...access, restorePs: 3 },
      { ...access, regi2cCalibrationStarted: false },
    ]) expect(restoreEsp32S3DirectBootIntlevel(initial, invalid).status).toBe("refused");
    const accepted = restoreEsp32S3DirectBootIntlevel(initial, access);
    if (!accepted.handled || accepted.status !== "accepted") throw new Error("intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(accepted.state, access).status).toBe("refused");
  });
});
