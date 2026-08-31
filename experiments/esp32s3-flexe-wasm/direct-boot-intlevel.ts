export const ESP32S3_ROM_SET_INTLEVEL = 0x4000_1c38;
export const ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS = 0x0004_0c00;
export const ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS = 0x0004_0c03;

export interface Esp32S3DirectBootIntlevelState {
  readonly intlevel: number;
  readonly restoreCount: number;
  readonly lastPc: number | null;
}

export interface Esp32S3DirectBootIntlevelAccess {
  readonly pc: number;
  readonly callinc: number;
  readonly restorePs: number;
  readonly regi2cCalibrationStarted: boolean;
}

export type Esp32S3DirectBootIntlevelDispatch =
  | Readonly<{
      handled: true;
      status: "accepted";
      returnValue: number;
      state: Esp32S3DirectBootIntlevelState;
    }>
  | Readonly<{
      handled: true;
      status: "refused";
      reason: string;
      state: Esp32S3DirectBootIntlevelState;
    }>;

export function createEsp32S3DirectBootIntlevel(): Esp32S3DirectBootIntlevelState {
  return Object.freeze({ intlevel: 3, restoreCount: 0, lastPc: null });
}

export function restoreEsp32S3DirectBootIntlevel(
  state: Esp32S3DirectBootIntlevelState,
  access: Esp32S3DirectBootIntlevelAccess,
): Esp32S3DirectBootIntlevelDispatch {
  if (access.pc !== ESP32S3_ROM_SET_INTLEVEL || access.callinc !== 2 ||
      access.restorePs !== ESP32S3_DIRECT_BOOT_INTLEVEL_RESTORE_PS ||
      !access.regi2cCalibrationStarted || state.intlevel !== 3 || state.restoreCount !== 0) {
    return Object.freeze({
      handled: true,
      status: "refused",
      reason: "_xtos_set_intlevel violated the observed xPortInIsrContext restore contract",
      state,
    });
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    returnValue: ESP32S3_DIRECT_BOOT_INTLEVEL_PREVIOUS_PS,
    state: Object.freeze({ intlevel: access.restorePs & 0xf, restoreCount: 1, lastPc: access.pc }),
  });
}
