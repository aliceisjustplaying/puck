// site/flasher/picoboot.test.ts: golden-byte tests for every PICOBOOT
// command packet builder. Each builder is a pure function (no USB object
// anywhere near it - see picoboot.ts's header comment), so these compare
// its output against a 32-byte hex string worked out by hand against the
// packet layout documented there:
//
//   [0:4]   magic 0x431FD10B, little-endian -> bytes 0b d1 1f 43
//   [4:8]   token, little-endian u32
//   [8]     cmdId
//   [9]     cmdSize
//   [10:12] reserved, zero
//   [12:16] transferLen, little-endian u32
//   [16:32] 16 bytes of command-specific args, zero-padded past cmdSize
//
// A human checking these against the RP2040/RP2350 bootrom's picoboot.h
// (or picotool's picoboot_connection.c) only needs to decode the hex back
// into those fields; the per-test comment below does that decoding once.
import { describe, expect, test } from "bun:test";
import {
  PICOBOOT_CMD,
  PICOBOOT_MAGIC,
  REBOOT2_FLAG_REBOOT_TYPE_NORMAL,
  buildExclusiveAccess,
  buildExitXip,
  buildFlashErase,
  buildReboot,
  buildReboot2,
  buildWrite,
} from "./picoboot";

function hex(b: Uint8Array): string {
  return [...b].map((x) => x.toString(16).padStart(2, "0")).join("");
}

test("PICOBOOT_MAGIC is 0x431FD10B", () => {
  expect(PICOBOOT_MAGIC).toBe(0x431fd10b);
});

describe("golden packet bytes", () => {
  test("EXCLUSIVE_ACCESS(token=1, exclusive=1): magic, token=1, cmd 0x01/size 1, no transfer, args[0]=1", () => {
    const packet = buildExclusiveAccess(1, 1);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4301000000010100000000000001000000000000000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.EXCLUSIVE_ACCESS);
  });

  test("EXIT_XIP(token=2): magic, token=2, cmd 0x06/size 0, no transfer, all-zero args", () => {
    const packet = buildExitXip(2);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4302000000060000000000000000000000000000000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.EXIT_XIP);
  });

  test("FLASH_ERASE(token=3, addr=0x10000000, size=0x1000): cmd 0x03/size 8, args = addr,size", () => {
    const packet = buildFlashErase(3, 0x10000000, 0x1000);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4303000000030800000000000000000010001000000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.FLASH_ERASE);
  });

  test("WRITE(token=4, addr=0x10000000, size=256): cmd 0x05/size 8, transferLen=256, args = addr,size", () => {
    const packet = buildWrite(4, 0x10000000, 256);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4304000000050800000001000000000010000100000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.WRITE);
  });

  // Coalesced writes (see uf2.ts's coalesceWriteRuns) send up to
  // PICOBOOT_MAX_WRITE_SIZE (32768) bytes per WRITE instead of one UF2
  // block (256 bytes) at a time; this is the header for a run at that cap.
  test("WRITE(token=7, addr=0x10000000, size=32768): cmd 0x05/size 8, transferLen=32768, args = addr,size", () => {
    const packet = buildWrite(7, 0x10000000, 32768);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4307000000050800000080000000000010008000000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.WRITE);
  });

  test("REBOOT2(token=5, flags=NORMAL, delay=500ms): cmd 0x0A/size 16, args = flags,delay,0,0", () => {
    expect(REBOOT2_FLAG_REBOOT_TYPE_NORMAL).toBe(0x0002);
    const packet = buildReboot2(5, REBOOT2_FLAG_REBOOT_TYPE_NORMAL, 500);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f43050000000a1000000000000002000000f40100000000000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.REBOOT2);
  });

  test("REBOOT(token=6, pc=0, sp=0, delay=500ms): cmd 0x02/size 12, args = pc,sp,delay,0", () => {
    const packet = buildReboot(6, 0, 0, 500);
    expect(packet.length).toBe(32);
    expect(hex(packet)).toBe("0bd11f4306000000020c0000000000000000000000000000f401000000000000");
    expect(packet[8]).toBe(PICOBOOT_CMD.REBOOT);
  });
});

describe("token propagation", () => {
  test("token is threaded into bytes [4:8] verbatim across every builder", () => {
    const token = 0x11223344;
    for (const packet of [
      buildExclusiveAccess(token, 1),
      buildExitXip(token),
      buildFlashErase(token, 0, 0),
      buildWrite(token, 0, 0),
      buildReboot2(token, 0, 0),
      buildReboot(token, 0, 0, 0),
    ]) {
      const view = new DataView(packet.buffer);
      expect(view.getUint32(4, true)).toBe(token >>> 0);
    }
  });
});
