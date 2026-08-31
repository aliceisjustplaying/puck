export const ESP32S3_ROM_I2C_WRITE_REG = 0x4000_5d60;
export const ESP32S3_ROM_I2C_WRITE_REG_MASK = 0x4000_5d6c;
export const ESP32S3_I2C_BBPLL = 0x66;
export const ESP32S3_I2C_BBPLL_HOST_ID = 1;
export const ESP32S3_BBPLL_MODE_HF = 4;
export const ESP32S3_BBPLL_MODE_HF_480M = 0x6b;
export const ESP32S3_BBPLL_OC_REF_DIV = 2;
export const ESP32S3_BBPLL_OC_REF_DIV_480M = 0x50;
export const ESP32S3_BBPLL_OC_DIV_7_0 = 3;
export const ESP32S3_BBPLL_OC_DIV_7_0_480M = 8;
export const ESP32S3_BBPLL_OC_DR1 = 5;
export const ESP32S3_BBPLL_OC_DR1_MSB = 2;
export const ESP32S3_BBPLL_OC_DR1_LSB = 0;
export const ESP32S3_BBPLL_OC_DR1_480M = 0;
export const ESP32S3_BBPLL_OC_DR3 = 5;
export const ESP32S3_BBPLL_OC_DR3_MSB = 6;
export const ESP32S3_BBPLL_OC_DR3_LSB = 4;
export const ESP32S3_BBPLL_OC_DR3_480M = 0;
export const ESP32S3_BBPLL_OC_DCUR = 6;
export const ESP32S3_BBPLL_OC_DCUR_480M = 0x73;

export interface Esp32S3DirectBootBbpllRomState {
  readonly modeHf: number | null;
  readonly refDiv: number | null;
  readonly div7_0: number | null;
  readonly dr1: number | null;
  readonly dr3: number | null;
  readonly dcur: number | null;
  readonly writeCount: number;
  readonly maskedWriteCount: number;
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

export interface Esp32S3DirectBootBbpllRomMaskAccess extends Esp32S3DirectBootBbpllRomAccess {
  readonly msb: number;
  readonly lsb: number;
  readonly priorMaskedWriteCount: number;
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
  return Object.freeze({
    modeHf: null,
    refDiv: null,
    div7_0: null,
    dr1: null,
    dr3: null,
    dcur: null,
    writeCount: 0,
    maskedWriteCount: 0,
    lastPc: null,
  });
}

export function writeEsp32S3DirectBootBbpllRom(
  state: Esp32S3DirectBootBbpllRomState,
  access: Esp32S3DirectBootBbpllRomAccess,
): Esp32S3DirectBootBbpllRomDispatch {
  const modeWrite = state.writeCount === 0 && state.modeHf === null && state.refDiv === null && state.div7_0 === null &&
    access.register === ESP32S3_BBPLL_MODE_HF && access.data === ESP32S3_BBPLL_MODE_HF_480M &&
    access.priorIntlevelRestoreCount === 1 && access.priorWriteCount === 0;
  const referenceDividerWrite = state.writeCount === 1 && state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === null && state.div7_0 === null && access.register === ESP32S3_BBPLL_OC_REF_DIV &&
    access.data === ESP32S3_BBPLL_OC_REF_DIV_480M && access.priorIntlevelRestoreCount === 4 &&
    access.priorWriteCount === 1;
  const dividerWrite = state.writeCount === 2 && state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === ESP32S3_BBPLL_OC_REF_DIV_480M && state.div7_0 === null &&
    access.register === ESP32S3_BBPLL_OC_DIV_7_0 && access.data === ESP32S3_BBPLL_OC_DIV_7_0_480M &&
    access.priorIntlevelRestoreCount === 7 && access.priorWriteCount === 2;
  const dcurWrite = state.writeCount === 3 && state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === ESP32S3_BBPLL_OC_REF_DIV_480M && state.div7_0 === ESP32S3_BBPLL_OC_DIV_7_0_480M &&
    state.dr1 === ESP32S3_BBPLL_OC_DR1_480M && state.dr3 === ESP32S3_BBPLL_OC_DR3_480M &&
    state.dcur === null && state.maskedWriteCount === 2 && access.register === ESP32S3_BBPLL_OC_DCUR &&
    access.data === ESP32S3_BBPLL_OC_DCUR_480M && access.priorIntlevelRestoreCount === 16 &&
    access.priorWriteCount === 3;
  if (access.pc !== ESP32S3_ROM_I2C_WRITE_REG || access.callinc !== 2 ||
      access.block !== ESP32S3_I2C_BBPLL || access.hostId !== ESP32S3_I2C_BBPLL_HOST_ID ||
      access.currentIntlevel !== 3 || !access.interruptLevelRestored ||
      (!modeWrite && !referenceDividerWrite && !dividerWrite && !dcurWrite)) {
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
      div7_0: dividerWrite ? access.data : state.div7_0,
      dr1: state.dr1,
      dr3: state.dr3,
      dcur: dcurWrite ? access.data : state.dcur,
      writeCount: state.writeCount + 1,
      maskedWriteCount: state.maskedWriteCount,
      lastPc: access.pc,
    }),
  });
}

export function writeEsp32S3DirectBootBbpllRomMask(
  state: Esp32S3DirectBootBbpllRomState,
  access: Esp32S3DirectBootBbpllRomMaskAccess,
): Esp32S3DirectBootBbpllRomDispatch {
  const exactDr1Write = state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === ESP32S3_BBPLL_OC_REF_DIV_480M && state.div7_0 === ESP32S3_BBPLL_OC_DIV_7_0_480M &&
    state.dr1 === null && state.dr3 === null && state.writeCount === 3 && state.maskedWriteCount === 0 &&
    access.register === ESP32S3_BBPLL_OC_DR1 && access.msb === ESP32S3_BBPLL_OC_DR1_MSB &&
    access.lsb === ESP32S3_BBPLL_OC_DR1_LSB && access.data === ESP32S3_BBPLL_OC_DR1_480M &&
    access.priorIntlevelRestoreCount === 10 && access.priorWriteCount === 3 &&
    access.priorMaskedWriteCount === 0;
  const exactDr3Write = state.modeHf === ESP32S3_BBPLL_MODE_HF_480M &&
    state.refDiv === ESP32S3_BBPLL_OC_REF_DIV_480M && state.div7_0 === ESP32S3_BBPLL_OC_DIV_7_0_480M &&
    state.dr1 === ESP32S3_BBPLL_OC_DR1_480M && state.dr3 === null && state.writeCount === 3 &&
    state.maskedWriteCount === 1 && access.register === ESP32S3_BBPLL_OC_DR3 &&
    access.msb === ESP32S3_BBPLL_OC_DR3_MSB && access.lsb === ESP32S3_BBPLL_OC_DR3_LSB &&
    access.data === ESP32S3_BBPLL_OC_DR3_480M && access.priorIntlevelRestoreCount === 13 &&
    access.priorWriteCount === 3 && access.priorMaskedWriteCount === 1;
  if (access.pc !== ESP32S3_ROM_I2C_WRITE_REG_MASK || access.callinc !== 2 ||
      access.block !== ESP32S3_I2C_BBPLL || access.hostId !== ESP32S3_I2C_BBPLL_HOST_ID ||
      access.currentIntlevel !== 3 || !access.interruptLevelRestored || (!exactDr1Write && !exactDr3Write)) {
    return Object.freeze({
      handled: true,
      status: "refused",
      reason: "rom_i2c_writeReg_Mask violated the observed ordered 480 MHz BBPLL DR1/DR3 contract",
      state,
    });
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    returnValue: 0,
    state: Object.freeze({
      ...state,
      dr1: exactDr1Write ? access.data : state.dr1,
      dr3: exactDr3Write ? access.data : state.dr3,
      maskedWriteCount: state.maskedWriteCount + 1,
      lastPc: access.pc,
    }),
  });
}
