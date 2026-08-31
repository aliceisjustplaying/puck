import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_RTC_DATE,
  ESP32S3_DIRECT_BOOT_RTC_DATE_XTAL,
  ESP32S3_DIRECT_BOOT_RTC_DATE_PROVENANCE,
  ESP32S3_DIRECT_BOOT_RTC_DATE_READ_PC,
  ESP32S3_DIRECT_BOOT_RTC_DATE_WRITE_PC,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PROVENANCE,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_READ_PC,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_READ_PC,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_WRITE_PC,
  ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_WRITE_PC,
  ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ,
  ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
  ESP32S3_DIRECT_BOOT_RTC_XTAL_PROVENANCE,
  ESP32S3_RTC_CNTL_MMIO_PAGE,
  ESP32S3_RTC_DATE_REG,
  ESP32S3_RTC_OPTIONS0_REG,
  ESP32S3_RTC_XTAL_FREQ_REG,
  createEsp32S3DirectBootRtcMmio,
  readEsp32S3DirectBootRtcMmio,
  writeEsp32S3DirectBootRtcMmio,
} from "./direct-boot-rtc-mmio";

describe("ESP32-S3 direct-boot RTCCNTL MMIO", () => {
  test("reads the bootloader-persisted 40 MHz crystal frequency", () => {
    expect(ESP32S3_RTC_CNTL_MMIO_PAGE).toBe(0x6000_8000);
    expect(ESP32S3_RTC_XTAL_FREQ_REG).toBe(0x6000_80c0);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC).toBe(0x4037_6f15);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ).toBe(0x0028_0028);
    expect(ESP32S3_DIRECT_BOOT_RTC_XTAL_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_XTAL_FREQ=40 and CONFIG_BOOT_ROM_LOG_ALWAYS_ON=1",
      store: "ESP-IDF v6.1 esp_hal_clock/esp32s3/include/hal/clk_tree_ll.h: clk_ll_xtal_store_freq_mhz",
      bootPath: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk_init.c: rtc_clk_init calls rtc_clk_xtal_freq_update",
      register: "ESP-IDF v6.1 esp32s3/rom/rtc.h: RTC_XTAL_FREQ_REG is RTC_CNTL_STORE4_REG",
    });
    const initial = createEsp32S3DirectBootRtcMmio();
    expect(readEsp32S3DirectBootRtcMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    })).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0028_0028,
      state: {
        xtalFreqReg: 0x0028_0028,
        readCount: 1,
        lastReadPc: 0x4037_6f15,
        dateReg: 0x0210_1271,
        dateReadCount: 0,
        dateLastReadPc: null,
        dateWriteCount: 0,
        dateLastWritePc: null,
        optionsReg: 0x1c00_8000,
        optionsReadCount: 0,
        optionsLastReadPc: null,
        optionsWriteCount: 0,
        optionsLastWritePc: null,
      },
    });
  });

  test("powers down the inherited bootloader BBPLL through the exact OPTIONS0 RMW", () => {
    expect(ESP32S3_RTC_OPTIONS0_REG).toBe(0x6000_8000);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0).toBe(0x1c00_8000);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD).toBe(0x1c00_8540);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_READ_PC).toBe(0x4037_d91f);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_WRITE_PC).toBe(0x4037_d928);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PROVENANCE).toEqual({
      reset: "ESP-IDF v6.1 soc/esp32s3/register/soc/rtc_cntl_reg.h: OPTIONS0 reset fields produce 0x1c00a000",
      bootloaderInit: "ESP-IDF v6.1 rtc.h RTC_CONFIG_DEFAULT plus rtc_init clears XTL_FORCE_PU, producing 0x1c008000",
      transition: "ESP-IDF v6.1 clk_tree_ll.h clk_ll_bbpll_disable ORs force-PD mask 0x540",
    });
    const initial = createEsp32S3DirectBootRtcMmio();
    const xtal = readEsp32S3DirectBootRtcMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    });
    if (!xtal.handled || xtal.status !== "accepted") throw new Error("XTAL read refused");
    const date = readEsp32S3DirectBootRtcMmio(xtal.state, {
      pc: ESP32S3_DIRECT_BOOT_RTC_DATE_READ_PC,
      address: ESP32S3_RTC_DATE_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    });
    if (!date.handled || date.status !== "accepted") throw new Error("DATE read refused");
    const dateWrite = writeEsp32S3DirectBootRtcMmio(date.state, {
      pc: ESP32S3_DIRECT_BOOT_RTC_DATE_WRITE_PC,
      address: ESP32S3_RTC_DATE_REG,
      width: 4,
      isWrite: true,
      value: ESP32S3_DIRECT_BOOT_RTC_DATE_XTAL,
      systemMmioComplete: true,
    });
    if (!dateWrite.handled || dateWrite.status !== "accepted") throw new Error("DATE write refused");
    const readAccess = {
      pc: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_READ_PC,
      address: ESP32S3_RTC_OPTIONS0_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    } as const;
    expect(readEsp32S3DirectBootRtcMmio(date.state, readAccess).status).toBe("refused");
    for (const invalid of [
      { ...readAccess, width: 2 },
      { ...readAccess, isWrite: true },
      { ...readAccess, pc: 0x4037_d91c },
      { ...readAccess, systemMmioComplete: false },
    ]) expect(readEsp32S3DirectBootRtcMmio(dateWrite.state, invalid).status).toBe("refused");
    const options = readEsp32S3DirectBootRtcMmio(dateWrite.state, readAccess);
    expect(options.status).toBe("accepted");
    if (!options.handled || options.status !== "accepted") throw new Error("OPTIONS0 read refused");
    expect(options.value).toBe(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0);
    expect(readEsp32S3DirectBootRtcMmio(options.state, readAccess).status).toBe("refused");

    const writeAccess = {
      pc: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_WRITE_PC,
      address: ESP32S3_RTC_OPTIONS0_REG,
      width: 4,
      isWrite: true,
      value: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD,
      systemMmioComplete: true,
    } as const;
    expect(writeEsp32S3DirectBootRtcMmio(dateWrite.state, writeAccess).status).toBe("refused");
    for (const invalid of [
      { ...writeAccess, width: 2 },
      { ...writeAccess, isWrite: false },
      { ...writeAccess, pc: 0x4037_d925 },
      { ...writeAccess, value: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0 },
      { ...writeAccess, systemMmioComplete: false },
    ]) expect(writeEsp32S3DirectBootRtcMmio(options.state, invalid).status).toBe("refused");
    const written = writeEsp32S3DirectBootRtcMmio(options.state, writeAccess);
    expect(written.status).toBe("accepted");
    if (!written.handled || written.status !== "accepted") throw new Error("OPTIONS0 write refused");
    expect(written.value).toBe(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD);
    expect(written.state.optionsReg).toBe(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD);
    expect(writeEsp32S3DirectBootRtcMmio(written.state, writeAccess).status).toBe("refused");

    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_READ_PC).toBe(0x4037_d780);
    expect(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_WRITE_PC).toBe(0x4037_d789);
    const restoreReadAccess = {
      ...readAccess,
      pc: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_READ_PC,
      systemClockRestoreStarted: true,
    } as const;
    expect(readEsp32S3DirectBootRtcMmio(written.state, {
      ...restoreReadAccess,
      systemClockRestoreStarted: false,
    }).status).toBe("refused");
    expect(readEsp32S3DirectBootRtcMmio(written.state, {
      ...restoreReadAccess,
      pc: 0x4037_d77d,
    }).status).toBe("refused");
    const restoreRead = readEsp32S3DirectBootRtcMmio(written.state, restoreReadAccess);
    expect(restoreRead.status).toBe("accepted");
    if (!restoreRead.handled || restoreRead.status !== "accepted") throw new Error("OPTIONS0 restore read refused");
    expect(restoreRead.value).toBe(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD);
    const restoreWriteAccess = {
      ...writeAccess,
      pc: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_RESTORE_WRITE_PC,
      value: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0,
      systemClockRestoreStarted: true,
    } as const;
    expect(writeEsp32S3DirectBootRtcMmio(written.state, restoreWriteAccess).status).toBe("refused");
    expect(writeEsp32S3DirectBootRtcMmio(restoreRead.state, {
      ...restoreWriteAccess,
      value: ESP32S3_DIRECT_BOOT_RTC_OPTIONS0_PLL_PD,
    }).status).toBe("refused");
    const restored = writeEsp32S3DirectBootRtcMmio(restoreRead.state, restoreWriteAccess);
    expect(restored.status).toBe("accepted");
    if (!restored.handled || restored.status !== "accepted") throw new Error("OPTIONS0 restore write refused");
    expect(restored.state.optionsReg).toBe(ESP32S3_DIRECT_BOOT_RTC_OPTIONS0);
    expect(restored.state.optionsReadCount).toBe(2);
    expect(restored.state.optionsWriteCount).toBe(2);
    expect(writeEsp32S3DirectBootRtcMmio(restored.state, restoreWriteAccess).status).toBe("refused");
    const repeatedXtalAccess = {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
      systemClockRestoreStarted: true,
    } as const;
    expect(readEsp32S3DirectBootRtcMmio(restored.state, {
      ...repeatedXtalAccess,
      systemClockRestoreStarted: false,
    }).status).toBe("refused");
    const repeatedXtal = readEsp32S3DirectBootRtcMmio(restored.state, repeatedXtalAccess);
    expect(repeatedXtal.status).toBe("accepted");
    if (!repeatedXtal.handled || repeatedXtal.status !== "accepted") throw new Error("repeated XTAL read refused");
    expect(repeatedXtal.value).toBe(ESP32S3_DIRECT_BOOT_RTC_XTAL_FREQ);
    expect(repeatedXtal.state.readCount).toBe(2);
    expect(readEsp32S3DirectBootRtcMmio(repeatedXtal.state, repeatedXtalAccess).status).toBe("refused");
  });

  test("reads the bootloader-configured LDO slave field before the XTAL transition update", () => {
    expect(ESP32S3_RTC_DATE_REG).toBe(0x6000_81fc);
    expect(ESP32S3_DIRECT_BOOT_RTC_DATE_READ_PC).toBe(0x4037_70bd);
    expect(ESP32S3_DIRECT_BOOT_RTC_DATE).toBe(0x0210_1271);
    expect(ESP32S3_DIRECT_BOOT_RTC_DATE_PROVENANCE).toEqual({
      reset: "ESP-IDF v6.1 soc/esp32s3/register/soc/rtc_cntl_reg.h: RTC_CNTL_DATE reset 0x02101271",
      bootPath: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_xtal updates RTC_CNTL_SLAVE_PD",
      ldoField: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/include/soc/rtc.h: DEFAULT_LDO_SLAVE=7 produces 0x0000e000",
    });
    const initial = createEsp32S3DirectBootRtcMmio();
    const xtal = readEsp32S3DirectBootRtcMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    });
    if (!xtal.handled || xtal.status !== "accepted") throw new Error("XTAL read refused");
    const valid = {
      pc: ESP32S3_DIRECT_BOOT_RTC_DATE_READ_PC,
      address: ESP32S3_RTC_DATE_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    } as const;
    expect(readEsp32S3DirectBootRtcMmio(initial, valid).status).toBe("refused");
    for (const invalid of [
      { ...valid, width: 2 },
      { ...valid, isWrite: true },
      { ...valid, pc: 0x4037_70ba },
      { ...valid, systemMmioComplete: false },
    ]) {
      const refused = readEsp32S3DirectBootRtcMmio(xtal.state, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(xtal.state);
    }
    const date = readEsp32S3DirectBootRtcMmio(xtal.state, valid);
    expect(date).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0210_1271,
      state: {
        ...xtal.state,
        dateReadCount: 1,
        dateLastReadPc: 0x4037_70bd,
      },
    });
    if (!date.handled || date.status !== "accepted") throw new Error("DATE read refused");
    const repeated = readEsp32S3DirectBootRtcMmio(date.state, valid);
    expect(repeated.status).toBe("refused");
    if (repeated.handled) expect(repeated.state).toBe(date.state);

    expect(ESP32S3_DIRECT_BOOT_RTC_DATE_WRITE_PC).toBe(0x4037_70cb);
    expect(ESP32S3_DIRECT_BOOT_RTC_DATE_XTAL).toBe(0x0210_f271);
    const writeAccess = {
      pc: ESP32S3_DIRECT_BOOT_RTC_DATE_WRITE_PC,
      address: ESP32S3_RTC_DATE_REG,
      width: 4,
      isWrite: true,
      value: ESP32S3_DIRECT_BOOT_RTC_DATE_XTAL,
      systemMmioComplete: true,
    } as const;
    expect(writeEsp32S3DirectBootRtcMmio(xtal.state, writeAccess).status).toBe("refused");
    for (const invalid of [
      { ...writeAccess, width: 2 },
      { ...writeAccess, isWrite: false },
      { ...writeAccess, value: ESP32S3_DIRECT_BOOT_RTC_DATE },
      { ...writeAccess, pc: 0x4037_70c8 },
      { ...writeAccess, systemMmioComplete: false },
      { ...writeAccess, address: ESP32S3_RTC_XTAL_FREQ_REG },
    ]) {
      const refused = writeEsp32S3DirectBootRtcMmio(date.state, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(date.state);
    }
    const write = writeEsp32S3DirectBootRtcMmio(date.state, writeAccess);
    expect(write).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0210_f271,
      state: {
        ...date.state,
        dateReg: 0x0210_f271,
        dateWriteCount: 1,
        dateLastWritePc: 0x4037_70cb,
      },
    });
    if (!write.handled || write.status !== "accepted") throw new Error("DATE write refused");
    const repeatedWrite = writeEsp32S3DirectBootRtcMmio(write.state, writeAccess);
    expect(repeatedWrite.status).toBe("refused");
    if (repeatedWrite.handled) expect(repeatedWrite.state).toBe(write.state);
  });

  test("refuses undeclared registers, invalid access shapes, order, readers, and repeats", () => {
    const initial = createEsp32S3DirectBootRtcMmio();
    const valid = {
      pc: ESP32S3_DIRECT_BOOT_RTC_XTAL_READ_PC,
      address: ESP32S3_RTC_XTAL_FREQ_REG,
      width: 4,
      isWrite: false,
      systemMmioComplete: true,
    } as const;
    for (const invalid of [
      { ...valid, address: 0x6000_80c4 },
      { ...valid, address: 0x6000_80c1 },
      { ...valid, width: 1 },
      { ...valid, width: 2 },
      { ...valid, isWrite: true },
      { ...valid, systemMmioComplete: false },
      { ...valid, pc: 0x4037_6f12 },
    ]) {
      const refused = readEsp32S3DirectBootRtcMmio(initial, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(initial);
    }
    expect(readEsp32S3DirectBootRtcMmio(initial, {
      ...valid,
      address: 0x600c_0010,
    })).toEqual({ handled: false });
    const accepted = readEsp32S3DirectBootRtcMmio(initial, valid);
    if (!accepted.handled || accepted.status !== "accepted") throw new Error("RTC read refused");
    const repeated = readEsp32S3DirectBootRtcMmio(accepted.state, valid);
    expect(repeated.status).toBe("refused");
    if (repeated.handled) expect(repeated.state).toBe(accepted.state);
  });
});
