export const ESP32S3_ROM_I2C_WRITE_REG = 0x4000_5d60;
export const ESP32S3_I2C_BBPLL = 0x66;
export const ESP32S3_I2C_BBPLL_HOST_ID = 1;
export const ESP32S3_BBPLL_MODE_HF = 4;
export const ESP32S3_BBPLL_MODE_HF_480M = 0x6b;
export const ESP32S3_BBPLL_OC_REF_DIV = 2;
export const ESP32S3_BBPLL_OC_REF_DIV_480M = 0x50;

export interface Esp32S3DirectBootBbpllRomState {
  readonly modeHf: number | null;
  readonly refDiv: number | null;
  readonly writeCount: number;
  readonly lastPc: number | null;
}

export interface Esp32S3DirectBootBbpllRomAccess {
  readonly pc: number;
  readonly callinc: number;
  readonly block: number;
  readonly hostId: number;
  readonly register: number;
  readonly data: number;
  readonly currentIntlevel: number;
  readonly interruptLevelRestored: boolean;
  readonly priorIntlevelRestoreCount: number;
  readonly priorWriteCount: number;
}

export type Esp32S3DirectBootBbpllRomDispatch =
  | Readonly<{
      handled: true;
      status: "accepted";
      returnValue: number;
      state: Esp32S3DirectBootBbpllRomState;
    }>
  | Readonly<{
      handled: true;
      status: "refused";
      reason: string;
      state: Esp32S3DirectBootBbpllRomState;
    }>;

export function createEsp32S3DirectBootBbpllRom(): Esp32S3DirectBootBbpllRomState {
  return Object.freeze({ modeHf: null, refDiv: null, writeCount: 0, lastPc: null });
}

export function writeEsp32S3DirectBootBbpllRom(
  state: Esp32S3DirectBootBbpllRomState,
  access: Esp32S3DirectBootBbpllRomAccess,
): Esp32S3DirectBootBbpllRomDispatch {
  const modeWrite = state.writeCount === 0 && state.modeHf === null && state.refDiv === null &&
    access.register === ESP32S3_BBPLL_MODE_HF && access.data === ESP32S3_BBPLL_MODE_HF_480M &&
    access.priorIntlevelRestoreCount === 1 && access.priorWriteCount === 0;
  const referenceDividerWrite = state.writeCount === 1 && state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === null && access.register === ESP32S3_BBPLL_OC_REF_DIV &&
    access.data === ESP32S3_BBPLL_OC_REF_DIV_480M && access.priorIntlevelRestoreCount === 4 &&
    access.priorWriteCount === 1;
  if (access.pc !== ESP32S3_ROM_I2C_WRITE_REG || access.callinc !== 2 ||
      access.block !== ESP32S3_I2C_BBPLL || access.hostId !== ESP32S3_I2C_BBPLL_HOST_ID ||
      access.currentIntlevel !== 3 || !access.interruptLevelRestored ||
      (!modeWrite && !referenceDividerWrite)) {
    return Object.freeze({
      handled: true,
      status: "refused",
      reason: "rom_i2c_writeReg violated the observed ordered 480 MHz BBPLL write contract",
      state,
    });
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    returnValue: 0,
    state: Object.freeze({
      modeHf: modeWrite ? access.data : state.modeHf,
      refDiv: referenceDividerWrite ? access.data : state.refDiv,
      writeCount: state.writeCount + 1,
      lastPc: access.pc,
    }),
  });
}
