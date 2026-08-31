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
      bbpllDividerWritten: false,
      bbpllDr1Written: false,
      bbpllDr3Written: false,
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
      bbpllDividerWritten: false,
      bbpllDr1Written: false,
      bbpllDr3Written: false,
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
    const seventh = restoreEsp32S3DirectBootIntlevel(sixth.state, sixthAccess);
    expect(seventh).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 7, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (seventh.status !== "accepted") throw new Error("seventh intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(seventh.state, sixthAccess).status).toBe("refused");
    const eighthAccess = {
      ...fifthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
      bbpllDividerWritten: true,
    };
    expect(restoreEsp32S3DirectBootIntlevel(seventh.state, {
      ...eighthAccess,
      bbpllDividerWritten: false,
    }).status).toBe("refused");
    const eighth = restoreEsp32S3DirectBootIntlevel(seventh.state, eighthAccess);
    expect(eighth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 3, restoreCount: 8, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (eighth.status !== "accepted") throw new Error("eighth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(eighth.state, eighthAccess).status).toBe("refused");
    const ninthAccess = {
      ...eighthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
    };
    const ninth = restoreEsp32S3DirectBootIntlevel(eighth.state, ninthAccess);
    expect(ninth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 9, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (ninth.status !== "accepted") throw new Error("ninth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(ninth.state, {
      ...ninthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
    }).status).toBe("refused");
    const tenth = restoreEsp32S3DirectBootIntlevel(ninth.state, ninthAccess);
    expect(tenth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 10, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (tenth.status !== "accepted") throw new Error("tenth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(tenth.state, ninthAccess).status).toBe("refused");
    const eleventhAccess = {
      ...ninthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
      bbpllDr1Written: true,
    };
    expect(restoreEsp32S3DirectBootIntlevel(tenth.state, {
      ...eleventhAccess,
      bbpllDr1Written: false,
    }).status).toBe("refused");
    const eleventh = restoreEsp32S3DirectBootIntlevel(tenth.state, eleventhAccess);
    expect(eleventh).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 3, restoreCount: 11, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (eleventh.status !== "accepted") throw new Error("eleventh intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(eleventh.state, eleventhAccess).status).toBe("refused");
    const twelfthAccess = {
      ...eleventhAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
    };
    const twelfth = restoreEsp32S3DirectBootIntlevel(eleventh.state, twelfthAccess);
    expect(twelfth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 12, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (twelfth.status !== "accepted") throw new Error("twelfth intlevel restore refused");
    const thirteenth = restoreEsp32S3DirectBootIntlevel(twelfth.state, twelfthAccess);
    expect(thirteenth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 13, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (thirteenth.status !== "accepted") throw new Error("thirteenth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(thirteenth.state, twelfthAccess).status).toBe("refused");
    const fourteenthAccess = {
      ...twelfthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_PRESERVE_PS,
      bbpllDr3Written: true,
    };
    expect(restoreEsp32S3DirectBootIntlevel(thirteenth.state, {
      ...fourteenthAccess,
      bbpllDr3Written: false,
    }).status).toBe("refused");
    const fourteenth = restoreEsp32S3DirectBootIntlevel(thirteenth.state, fourteenthAccess);
    expect(fourteenth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 3, restoreCount: 14, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (fourteenth.status !== "accepted") throw new Error("fourteenth intlevel restore refused");
    const fifteenthAccess = {
      ...fourteenthAccess,
      restorePs: ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS,
    };
    const fifteenth = restoreEsp32S3DirectBootIntlevel(fourteenth.state, fifteenthAccess);
    expect(fifteenth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 15, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (fifteenth.status !== "accepted") throw new Error("fifteenth intlevel restore refused");
    const sixteenth = restoreEsp32S3DirectBootIntlevel(fifteenth.state, fifteenthAccess);
    expect(sixteenth).toEqual({
      handled: true,
      status: "accepted",
      returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
      state: { intlevel: 0, restoreCount: 16, lastPc: ESP32S3_ROM_SET_INTLEVEL },
    });
    if (sixteenth.status !== "accepted") throw new Error("sixteenth intlevel restore refused");
    expect(restoreEsp32S3DirectBootIntlevel(sixteenth.state, fifteenthAccess).status).toBe("refused");
  });
});
