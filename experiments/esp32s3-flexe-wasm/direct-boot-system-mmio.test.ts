import { describe, expect, test } from "bun:test";
import {
  ESP32S3_DIRECT_BOOT_CPU_PER_CONF,
  ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
  ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
  ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_READ_PC,
  ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_WRITE_PC,
  ESP32S3_DIRECT_BOOT_CPU_PER_PROVENANCE,
  ESP32S3_DIRECT_BOOT_SYSCLK_CONF,
  ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_READ_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_WRITE_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_POST_ADJUST_READ_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_XTAL_WRITE_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_READ_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_WRITE_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_PLL_RESTORE_READ_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC,
  ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE,
  ESP32S3_SYSTEM_MMIO_PAGE,
  ESP32S3_SYSTEM_CPU_PER_CONF_REG,
  ESP32S3_SYSTEM_SYSCLK_CONF_REG,
  createEsp32S3DirectBootSystemMmio,
  readEsp32S3DirectBootSystemMmio,
  writeEsp32S3DirectBootSystemMmio,
} from "./direct-boot-system-mmio";

describe("ESP32-S3 direct-boot system MMIO", () => {
  test("reads the bootloader-configured PLL source at the observed CPU clock probe", () => {
    expect(ESP32S3_SYSTEM_MMIO_PAGE).toBe(0x600c_0000);
    expect(ESP32S3_SYSTEM_SYSCLK_CONF_REG).toBe(0x600c_0060);
    expect(ESP32S3_DIRECT_BOOT_SYSCLK_CONF).toBe(0x0000_0400);
    expect(ESP32S3_DIRECT_BOOT_SYSCLK_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
      source: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/rtc_clk.c: rtc_clk_cpu_freq_to_pll_mhz",
      register: "ESP-IDF v6.1 soc/esp32s3/register/soc/system_reg.h: SYSTEM_SYSCLK_CONF_REG",
    });
    const initial = createEsp32S3DirectBootSystemMmio();
    const read = readEsp32S3DirectBootSystemMmio(initial, {
      pc: 0x4037_6f61,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    expect(read).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0000_0400,
      state: {
        sysclkConf: 0x0000_0400,
        readCount: 1,
        lastReadPc: 0x4037_6f61,
        cpuPerConf: 0x0000_0004,
        cpuPerReadCount: 0,
        cpuPerLastReadPc: null,
        writeCount: 0,
        lastWritePc: null,
        cpuPerWriteCount: 0,
        cpuPerLastWritePc: null,
      },
    });
  });

  test("reads the bootloader-configured 80 MHz CPU period after the clock source", () => {
    expect(ESP32S3_SYSTEM_CPU_PER_CONF_REG).toBe(0x600c_0010);
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC).toBe(0x4037_6f92);
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_CONF).toBe(0x0000_0004);
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_PROVENANCE).toEqual({
      bootloaderConfig: "bootloader/config/sdkconfig.h: CONFIG_BOOTLOADER_CPU_CLK_FREQ_MHZ=80",
      clockSource: "ESP-IDF v6.1 esp_hal_clock/esp32s3/include/hal/clk_tree_ll.h: clk_ll_cpu_set_freq_mhz_from_pll",
      waitMode: "ESP-IDF v6.1 esp_hw_support/port/esp32s3/include/soc/rtc.h + rtc_init.c: default cpu_waiti_clk_gate=1 clears WAIT_MODE_FORCE_ON",
      register: "ESP-IDF v6.1 soc/esp32s3/register/soc/system_reg.h: SYSTEM_CPU_PER_CONF_REG",
    });
    const initial = createEsp32S3DirectBootSystemMmio();
    const access = {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    } as const;
    expect(readEsp32S3DirectBootSystemMmio(initial, access).status).toBe("refused");
    const source = readEsp32S3DirectBootSystemMmio(initial, {
      pc: 0x4037_6f61,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!source.handled || source.status !== "accepted") throw new Error("source read refused");
    expect(readEsp32S3DirectBootSystemMmio(source.state, access)).toEqual({
      handled: true,
      status: "accepted",
      value: 0x0000_0004,
      state: {
        sysclkConf: 0x0000_0400,
        readCount: 1,
        lastReadPc: 0x4037_6f61,
        cpuPerConf: 0x0000_0004,
        cpuPerReadCount: 1,
        cpuPerLastReadPc: 0x4037_6f92,
        writeCount: 0,
        lastWritePc: null,
        cpuPerWriteCount: 0,
        cpuPerLastWritePc: null,
      },
    });
  });

  test("permits the distinct ordered CPU period reader exactly once", () => {
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC).toBe(0x4037_6fbb);
    const initial = createEsp32S3DirectBootSystemMmio();
    const source = readEsp32S3DirectBootSystemMmio(initial, {
      pc: 0x4037_6f61,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!source.handled || source.status !== "accepted") throw new Error("source read refused");
    const first = readEsp32S3DirectBootSystemMmio(source.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!first.handled || first.status !== "accepted") throw new Error("first CPU period read refused");
    expect(readEsp32S3DirectBootSystemMmio(first.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    })).toEqual({
      handled: true,
      status: "accepted",
      value: 0x4,
      state: {
        ...first.state,
        cpuPerReadCount: 2,
        cpuPerLastReadPc: 0x4037_6fbb,
      },
    });
  });

  test("permits the repeated clock-source and first CPU-period readers after the RTC crystal read", () => {
    const initial = createEsp32S3DirectBootSystemMmio();
    const firstSource = readEsp32S3DirectBootSystemMmio(initial, {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!firstSource.handled || firstSource.status !== "accepted") throw new Error("source read refused");
    const firstCpu = readEsp32S3DirectBootSystemMmio(firstSource.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!firstCpu.handled || firstCpu.status !== "accepted") throw new Error("first CPU read refused");
    const secondCpu = readEsp32S3DirectBootSystemMmio(firstCpu.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    if (!secondCpu.handled || secondCpu.status !== "accepted") throw new Error("second CPU read refused");
    const repeatedSource = readEsp32S3DirectBootSystemMmio(secondCpu.state, {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(repeatedSource).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: {
        ...secondCpu.state,
        readCount: 2,
        lastReadPc: 0x4037_6f61,
      },
    });
    if (!repeatedSource.handled || repeatedSource.status !== "accepted") {
      throw new Error("repeated source read refused");
    }
    const outOfOrderCpu = readEsp32S3DirectBootSystemMmio(repeatedSource.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(outOfOrderCpu.status).toBe("refused");
    if (outOfOrderCpu.handled) expect(outOfOrderCpu.state).toBe(repeatedSource.state);
    const missingRtcState = readEsp32S3DirectBootSystemMmio(repeatedSource.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    });
    expect(missingRtcState.status).toBe("refused");
    if (missingRtcState.handled) expect(missingRtcState.state).toBe(repeatedSource.state);
    const repeatedCpu = readEsp32S3DirectBootSystemMmio(repeatedSource.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(repeatedCpu).toEqual({
      handled: true,
      status: "accepted",
      value: 0x4,
      state: {
        ...repeatedSource.state,
        cpuPerReadCount: 3,
        cpuPerLastReadPc: 0x4037_6f92,
      },
    });
    if (!repeatedCpu.handled || repeatedCpu.status !== "accepted") {
      throw new Error("repeated CPU-period read refused");
    }
    const thirdCpu = readEsp32S3DirectBootSystemMmio(repeatedCpu.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(thirdCpu.status).toBe("refused");
    if (thirdCpu.handled) expect(thirdCpu.state).toBe(repeatedCpu.state);
    const secondRepeatedCpu = readEsp32S3DirectBootSystemMmio(repeatedCpu.state, {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(secondRepeatedCpu).toEqual({
      handled: true,
      status: "accepted",
      value: 0x4,
      state: {
        ...repeatedCpu.state,
        cpuPerReadCount: 4,
        cpuPerLastReadPc: 0x4037_6fbb,
      },
    });
    if (!secondRepeatedCpu.handled || secondRepeatedCpu.status !== "accepted") {
      throw new Error("second repeated CPU-period read refused");
    }
    for (const pc of [ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC, ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC]) {
      const extraCpu = readEsp32S3DirectBootSystemMmio(secondRepeatedCpu.state, {
        pc,
        address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
        width: 4,
        isWrite: false,
        rtcMmioComplete: true,
      });
      expect(extraCpu.status).toBe("refused");
      if (extraCpu.handled) expect(extraCpu.state).toBe(secondRepeatedCpu.state);
    }
    const postTicksAccess = {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
      cpuTicksConfigured: true,
    } as const;
    const beforeTicks = readEsp32S3DirectBootSystemMmio(secondRepeatedCpu.state, {
      ...postTicksAccess,
      cpuTicksConfigured: false,
    });
    expect(beforeTicks.status).toBe("refused");
    if (beforeTicks.handled) expect(beforeTicks.state).toBe(secondRepeatedCpu.state);
    const postTicks = readEsp32S3DirectBootSystemMmio(secondRepeatedCpu.state, postTicksAccess);
    expect(postTicks).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: {
        ...secondRepeatedCpu.state,
        readCount: 3,
        lastReadPc: 0x4037_7031,
      },
    });
    if (!postTicks.handled || postTicks.status !== "accepted") throw new Error("post-ticks source read refused");
    const writeAccess = {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_POST_TICKS_WRITE_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: true,
      value: 0x400,
      rtcMmioComplete: true,
      cpuTicksConfigured: true,
    } as const;
    for (const invalid of [
      { ...writeAccess, pc: 0x4037_7036 },
      { ...writeAccess, address: ESP32S3_SYSTEM_CPU_PER_CONF_REG },
      { ...writeAccess, width: 2 },
      { ...writeAccess, isWrite: false },
      { ...writeAccess, value: 0 },
      { ...writeAccess, rtcMmioComplete: false },
      { ...writeAccess, cpuTicksConfigured: false },
    ]) {
      const refused = writeEsp32S3DirectBootSystemMmio(postTicks.state, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(postTicks.state);
    }
    const write = writeEsp32S3DirectBootSystemMmio(postTicks.state, writeAccess);
    expect(write).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: { ...postTicks.state, writeCount: 1, lastWritePc: 0x4037_7039 },
    });
    if (!write.handled || write.status !== "accepted") throw new Error("post-ticks source write refused");
    const adjustReadAccess = {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
      cpuTicksConfigured: true,
    } as const;
    const beforeWrite = readEsp32S3DirectBootSystemMmio(postTicks.state, adjustReadAccess);
    expect(beforeWrite.status).toBe("refused");
    if (beforeWrite.handled) expect(beforeWrite.state).toBe(postTicks.state);
    const adjustRead = readEsp32S3DirectBootSystemMmio(write.state, adjustReadAccess);
    expect(adjustRead).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: { ...write.state, readCount: 4, lastReadPc: 0x4037_7050 },
    });
    if (!adjustRead.handled || adjustRead.status !== "accepted") throw new Error("clock-adjust read refused");
    const adjustWriteAccess = {
      ...writeAccess,
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_ADJUST_WRITE_PC,
    } as const;
    const beforeAdjustRead = writeEsp32S3DirectBootSystemMmio(write.state, adjustWriteAccess);
    expect(beforeAdjustRead.status).toBe("refused");
    if (beforeAdjustRead.handled) expect(beforeAdjustRead.state).toBe(write.state);
    const adjustWrite = writeEsp32S3DirectBootSystemMmio(adjustRead.state, adjustWriteAccess);
    expect(adjustWrite).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: { ...adjustRead.state, writeCount: 2, lastWritePc: 0x4037_7061 },
    });
    if (!adjustWrite.handled || adjustWrite.status !== "accepted") throw new Error("clock-adjust write refused");
    const thirdWrite = writeEsp32S3DirectBootSystemMmio(adjustWrite.state, adjustWriteAccess);
    expect(thirdWrite.status).toBe("refused");
    if (thirdWrite.handled) expect(thirdWrite.state).toBe(adjustWrite.state);
    const postAdjustReadAccess = {
      ...adjustReadAccess,
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_POST_ADJUST_READ_PC,
    } as const;
    const fifthRead = readEsp32S3DirectBootSystemMmio(adjustRead.state, postAdjustReadAccess);
    expect(fifthRead.status).toBe("refused");
    if (fifthRead.handled) expect(fifthRead.state).toBe(adjustRead.state);
    const postAdjustRead = readEsp32S3DirectBootSystemMmio(adjustWrite.state, postAdjustReadAccess);
    expect(postAdjustRead).toEqual({
      handled: true,
      status: "accepted",
      value: 0x400,
      state: { ...adjustWrite.state, readCount: 5, lastReadPc: 0x4037_7066 },
    });
    if (!postAdjustRead.handled || postAdjustRead.status !== "accepted") {
      throw new Error("post-adjust read refused");
    }
    const xtalWriteAccess = {
      ...writeAccess,
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_XTAL_WRITE_PC,
      value: 0,
    } as const;
    const beforePostAdjustRead = writeEsp32S3DirectBootSystemMmio(adjustWrite.state, xtalWriteAccess);
    expect(beforePostAdjustRead.status).toBe("refused");
    if (beforePostAdjustRead.handled) expect(beforePostAdjustRead.state).toBe(adjustWrite.state);
    const wrongXtalValue = writeEsp32S3DirectBootSystemMmio(postAdjustRead.state, {
      ...xtalWriteAccess,
      value: 0x400,
    });
    expect(wrongXtalValue.status).toBe("refused");
    if (wrongXtalValue.handled) expect(wrongXtalValue.state).toBe(postAdjustRead.state);
    const xtalWrite = writeEsp32S3DirectBootSystemMmio(postAdjustRead.state, xtalWriteAccess);
    expect(xtalWrite).toEqual({
      handled: true,
      status: "accepted",
      value: 0,
      state: {
        ...postAdjustRead.state,
        sysclkConf: 0,
        writeCount: 3,
        lastWritePc: 0x4037_7074,
      },
    });
    if (!xtalWrite.handled || xtalWrite.status !== "accepted") throw new Error("XTAL source write refused");
    expect(ESP32S3_DIRECT_BOOT_SYSCLK_PLL_RESTORE_READ_PC).toBe(0x4037_d71f);
    const pllRestoreReadAccess = {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_PLL_RESTORE_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
      rtcClockTransitionComplete: true,
      cpuTicksConfigured: true,
    } as const;
    expect(readEsp32S3DirectBootSystemMmio(xtalWrite.state, {
      ...pllRestoreReadAccess,
      rtcClockTransitionComplete: false,
    }).status).toBe("refused");
    expect(readEsp32S3DirectBootSystemMmio(xtalWrite.state, {
      ...pllRestoreReadAccess,
      pc: 0x4037_d71c,
    }).status).toBe("refused");
    const pllRestoreRead = readEsp32S3DirectBootSystemMmio(xtalWrite.state, pllRestoreReadAccess);
    expect(pllRestoreRead).toEqual({
      handled: true,
      status: "accepted",
      value: 0,
      state: {
        ...xtalWrite.state,
        readCount: 6,
        lastReadPc: 0x4037_d71f,
      },
    });
    if (!pllRestoreRead.handled || pllRestoreRead.status !== "accepted") {
      throw new Error("PLL-restore source read refused");
    }
    expect(readEsp32S3DirectBootSystemMmio(pllRestoreRead.state, pllRestoreReadAccess).status).toBe("refused");
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_READ_PC).toBe(0x4037_d7e8);
    expect(ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_WRITE_PC).toBe(0x4037_d7f3);
    const pllCpuReadAccess = {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
      rtcClockTransitionComplete: true,
      rtcClockRestoreXtalReadComplete: true,
      cpuTicksConfigured: true,
    } as const;
    expect(readEsp32S3DirectBootSystemMmio(pllRestoreRead.state, {
      ...pllCpuReadAccess,
      rtcClockRestoreXtalReadComplete: false,
    }).status).toBe("refused");
    const pllCpuRead = readEsp32S3DirectBootSystemMmio(pllRestoreRead.state, pllCpuReadAccess);
    expect(pllCpuRead.status).toBe("accepted");
    if (!pllCpuRead.handled || pllCpuRead.status !== "accepted") throw new Error("PLL CPU period read refused");
    expect(pllCpuRead.value).toBe(ESP32S3_DIRECT_BOOT_CPU_PER_CONF);
    const pllCpuWriteAccess = {
      ...pllCpuReadAccess,
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_WRITE_PC,
      isWrite: true,
      value: ESP32S3_DIRECT_BOOT_CPU_PER_CONF,
    } as const;
    expect(writeEsp32S3DirectBootSystemMmio(pllRestoreRead.state, pllCpuWriteAccess).status).toBe("refused");
    expect(writeEsp32S3DirectBootSystemMmio(pllCpuRead.state, {
      ...pllCpuWriteAccess,
      value: 0,
    }).status).toBe("refused");
    const pllCpuWrite = writeEsp32S3DirectBootSystemMmio(pllCpuRead.state, pllCpuWriteAccess);
    expect(pllCpuWrite.status).toBe("accepted");
    if (!pllCpuWrite.handled || pllCpuWrite.status !== "accepted") throw new Error("PLL CPU period write refused");
    expect(pllCpuWrite.state.cpuPerWriteCount).toBe(1);
    expect(pllCpuWrite.state.cpuPerLastWritePc).toBe(ESP32S3_DIRECT_BOOT_CPU_PER_PLL_RESTORE_WRITE_PC);
    expect(writeEsp32S3DirectBootSystemMmio(pllCpuWrite.state, pllCpuWriteAccess).status).toBe("refused");
    const repeatedXtalWrite = writeEsp32S3DirectBootSystemMmio(xtalWrite.state, xtalWriteAccess);
    expect(repeatedXtalWrite.status).toBe("refused");
    if (repeatedXtalWrite.handled) expect(repeatedXtalWrite.state).toBe(xtalWrite.state);
    const sixthRead = readEsp32S3DirectBootSystemMmio(postAdjustRead.state, postAdjustReadAccess);
    expect(sixthRead.status).toBe("refused");
    if (sixthRead.handled) expect(sixthRead.state).toBe(postAdjustRead.state);
    const repeatedWrite = writeEsp32S3DirectBootSystemMmio(write.state, writeAccess);
    expect(repeatedWrite.status).toBe("refused");
    if (repeatedWrite.handled) expect(repeatedWrite.state).toBe(write.state);
    const fourthSource = readEsp32S3DirectBootSystemMmio(postTicks.state, postTicksAccess);
    expect(fourthSource.status).toBe("refused");
    if (fourthSource.handled) expect(fourthSource.state).toBe(postTicks.state);
    const thirdSource = readEsp32S3DirectBootSystemMmio(repeatedSource.state, {
      pc: ESP32S3_DIRECT_BOOT_SYSCLK_READ_PC,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: true,
    });
    expect(thirdSource.status).toBe("refused");
    if (thirdSource.handled) expect(thirdSource.state).toBe(repeatedSource.state);
  });

  test("refuses undeclared registers, invalid access shapes, readers, and repeats", () => {
    const initial = createEsp32S3DirectBootSystemMmio();
    const valid = {
      pc: 0x4037_6f61,
      address: ESP32S3_SYSTEM_SYSCLK_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    } as const;
    for (const invalid of [
      { ...valid, address: 0x600c_0064 },
      { ...valid, address: 0x600c_0061 },
      { ...valid, width: 1 },
      { ...valid, width: 2 },
      { ...valid, isWrite: true },
      { ...valid, pc: 0x4037_6f5e },
      { ...valid, rtcMmioComplete: true },
    ]) {
      const refused = readEsp32S3DirectBootSystemMmio(initial, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(initial);
    }
    expect(readEsp32S3DirectBootSystemMmio(initial, {
      ...valid,
      address: 0x600c_4004,
    })).toEqual({ handled: false });
    const accepted = readEsp32S3DirectBootSystemMmio(initial, valid);
    if (!accepted.handled || accepted.status !== "accepted") throw new Error("read refused");
    const repeated = readEsp32S3DirectBootSystemMmio(accepted.state, valid);
    expect(repeated.status).toBe("refused");
    if (repeated.handled) expect(repeated.state).toBe(accepted.state);

    const cpuAccess = {
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_READ_PC,
      address: ESP32S3_SYSTEM_CPU_PER_CONF_REG,
      width: 4,
      isWrite: false,
      rtcMmioComplete: false,
    } as const;
    for (const invalid of [
      { ...cpuAccess, width: 1 },
      { ...cpuAccess, width: 2 },
      { ...cpuAccess, isWrite: true },
      { ...cpuAccess, pc: 0x4037_6f8f },
    ]) {
      const refused = readEsp32S3DirectBootSystemMmio(accepted.state, invalid);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(accepted.state);
    }
    const cpu = readEsp32S3DirectBootSystemMmio(accepted.state, cpuAccess);
    if (!cpu.handled || cpu.status !== "accepted") throw new Error("CPU period read refused");
    const repeatedCpu = readEsp32S3DirectBootSystemMmio(cpu.state, cpuAccess);
    expect(repeatedCpu.status).toBe("refused");
    if (repeatedCpu.handled) expect(repeatedCpu.state).toBe(cpu.state);
    const secondCpuAccess = {
      ...cpuAccess,
      pc: ESP32S3_DIRECT_BOOT_CPU_PER_SECOND_READ_PC,
    } as const;
    const outOfOrderCpu = readEsp32S3DirectBootSystemMmio(accepted.state, secondCpuAccess);
    expect(outOfOrderCpu.status).toBe("refused");
    if (outOfOrderCpu.handled) expect(outOfOrderCpu.state).toBe(accepted.state);
    const secondCpu = readEsp32S3DirectBootSystemMmio(cpu.state, secondCpuAccess);
    if (!secondCpu.handled || secondCpu.status !== "accepted") {
      throw new Error("second CPU period read refused");
    }
    for (const third of [secondCpuAccess, cpuAccess]) {
      const refused = readEsp32S3DirectBootSystemMmio(secondCpu.state, third);
      expect(refused.status).toBe("refused");
      if (refused.handled) expect(refused.state).toBe(secondCpu.state);
    }
  });
});
