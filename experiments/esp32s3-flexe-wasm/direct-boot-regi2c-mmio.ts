export const ESP32S3_I2C_MST_MMIO_PAGE = 0x6000_e000;
export const ESP32S3_I2C_MST_ANA_CONF0_REG = 0x6000_e040;
export const ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_READ_PC = 0x4037_f6b8;
export const ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_WRITE_PC = 0x4037_f6c2;
export const ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC = 0x4037_f6c7;
export const ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_WRITE_PC = 0x4037_f6d1;

/* Prior bootloader calibration completed and calibration_stop selected FORCE_HIGH. */
export const ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0 = 0x0100_0004;
export const ESP32S3_DIRECT_BOOT_I2C_MST_CAL_START_LOW = 0x0100_0008;
export const ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0_PROVENANCE = Object.freeze({
  source: "ESP-IDF v6.0.2 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_bbpll_configure",
  register: "ESP-IDF v6.0.2 soc/esp32s3/include/soc/regi2c_defs.h: I2C_MST_ANA_CONF0_REG",
  inheritedState: "prior bootloader calibration observed CAL_DONE then calibration_stop selected FORCE_HIGH",
});

export interface Esp32S3DirectBootRegi2cMmioState {
  readonly anaConf0: number;
  readonly readCount: number;
  readonly lastReadPc: number | null;
  readonly writeCount: number;
  readonly lastWritePc: number | null;
}

export interface Esp32S3DirectBootRegi2cMmioAccess {
  readonly pc: number;
  readonly address: number;
  readonly width: number;
  readonly isWrite: boolean;
  readonly clockRestoreComplete: boolean;
}

export type Esp32S3DirectBootRegi2cMmioDispatch =
  | Readonly<{ handled: false; status?: never }>
  | Readonly<{ handled: true; status: "refused"; reason: string; state: Esp32S3DirectBootRegi2cMmioState }>
  | Readonly<{
      handled: true;
      status: "accepted";
      value: number;
      state: Esp32S3DirectBootRegi2cMmioState;
    }>;

export function createEsp32S3DirectBootRegi2cMmio(): Esp32S3DirectBootRegi2cMmioState {
  return Object.freeze({
    anaConf0: ESP32S3_DIRECT_BOOT_I2C_MST_ANA_CONF0,
    readCount: 0,
    lastReadPc: null,
    writeCount: 0,
    lastWritePc: null,
  });
}

function refuse(
  state: Esp32S3DirectBootRegi2cMmioState,
  reason: string,
): Esp32S3DirectBootRegi2cMmioDispatch {
  return Object.freeze({ handled: true, status: "refused", reason, state });
}

export function readEsp32S3DirectBootRegi2cMmio(
  state: Esp32S3DirectBootRegi2cMmioState,
  access: Esp32S3DirectBootRegi2cMmioAccess,
): Esp32S3DirectBootRegi2cMmioDispatch {
  if ((access.address & ~0xfff) !== ESP32S3_I2C_MST_MMIO_PAGE) return Object.freeze({ handled: false });
  if (access.address !== ESP32S3_I2C_MST_ANA_CONF0_REG || access.width !== 4 || access.isWrite ||
      !access.clockRestoreComplete || state.readCount >= 2 || state.readCount !== state.writeCount) {
    return refuse(state, "I2C_MST_ANA_CONF0 read violated the observed BBPLL calibration-start contract");
  }
  const expectedPc = state.readCount === 0
    ? ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_READ_PC
    : ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_READ_PC;
  if (access.pc !== expectedPc) return refuse(state, `unexpected I2C_MST_ANA_CONF0 reader 0x${access.pc.toString(16)}`);
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: state.anaConf0,
    state: Object.freeze({ ...state, readCount: state.readCount + 1, lastReadPc: access.pc }),
  });
}

export function writeEsp32S3DirectBootRegi2cMmio(
  state: Esp32S3DirectBootRegi2cMmioState,
  access: Esp32S3DirectBootRegi2cMmioAccess & Readonly<{ value: number }>,
): Esp32S3DirectBootRegi2cMmioDispatch {
  if ((access.address & ~0xfff) !== ESP32S3_I2C_MST_MMIO_PAGE) return Object.freeze({ handled: false });
  if (access.address !== ESP32S3_I2C_MST_ANA_CONF0_REG || access.width !== 4 || !access.isWrite ||
      !access.clockRestoreComplete || state.writeCount >= 2 || state.readCount !== state.writeCount + 1) {
    return refuse(state, "I2C_MST_ANA_CONF0 write violated the observed BBPLL calibration-start contract");
  }
  const first = state.writeCount === 0;
  const expectedPc = first
    ? ESP32S3_DIRECT_BOOT_I2C_MST_START_CLEAR_WRITE_PC
    : ESP32S3_DIRECT_BOOT_I2C_MST_START_SET_WRITE_PC;
  const expectedValue = first ? 0x0100_0000 : ESP32S3_DIRECT_BOOT_I2C_MST_CAL_START_LOW;
  if (access.pc !== expectedPc || access.value !== expectedValue) {
    return refuse(state, "I2C_MST_ANA_CONF0 write PC or value differs from the observed RMW");
  }
  return Object.freeze({
    handled: true,
    status: "accepted",
    value: access.value,
    state: Object.freeze({
      ...state,
      anaConf0: access.value,
      writeCount: state.writeCount + 1,
      lastWritePc: access.pc,
    }),
  });
}
