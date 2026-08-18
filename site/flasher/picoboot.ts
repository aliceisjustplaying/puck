// site/flasher/picoboot.ts: the PICOBOOT protocol, spoken over WebUSB.
//
// PICOBOOT is the RP2040/RP2350 BOOTSEL-mode USB interface: a vendor
// (class 0xFF) interface exposing one bulk OUT and one bulk IN endpoint,
// used to erase and write flash and to reboot the chip, all without ever
// exposing a mass-storage filesystem. It's what `picotool load` speaks
// over libusb; this is the same protocol spoken directly from the browser.
//
// Every command is a fixed 32-byte packet sent on the bulk OUT endpoint:
//
//   0   u32 magic       0x431FD10B (PICOBOOT_MAGIC)
//   4   u32 token        arbitrary, echoed back by some responses; we just
//                        need it to increase so a device can dedupe retries
//   8   u8  cmdId
//   9   u8  cmdSize      length, in bytes, of the meaningful prefix of args
//   10  u16 (reserved, zero)
//   12  u32 transferLen  bytes to move in the data phase that follows (0
//                        for commands with no data phase; WRITE sets this
//                        to the payload length it's about to send)
//   16  u16[16] args     command-specific, zero-padded past cmdSize
//
// After the command packet (and, for WRITE, after sending `transferLen`
// bytes of payload on bulk OUT), the host reads a short acknowledge packet
// on bulk IN before issuing the next command. A STALL on either endpoint
// during this exchange is cleared with clearHalt before surfacing the
// error, per the WebUSB stall-recovery pattern; there is nothing else a
// browser-side client can do about a STALL.
//
// Every packet builder below is a pure function: bytes in (a token and
// some numbers), bytes out (32-byte Uint8Array), no USB object touched.
// That's what picoboot.test.ts exercises with fixed golden hex, with no
// hardware anywhere near the test.
//
// Command IDs and packet shape per the RP2040/RP2350 bootrom's own
// `picoboot.h` (as shipped in pico-sdk and used by picotool's
// picoboot_connection.c). REBOOT2 is the RP2350 addition (RP2040 only has
// plain REBOOT); this module always tries REBOOT2 first and falls back to
// REBOOT (see flash.ts).

export const PICOBOOT_MAGIC = 0x431fd10b;

export const PICOBOOT_CMD = {
  EXCLUSIVE_ACCESS: 0x01,
  REBOOT: 0x02,
  FLASH_ERASE: 0x03,
  WRITE: 0x05,
  EXIT_XIP: 0x06,
  REBOOT2: 0x0a,
} as const;

export const REBOOT2_FLAG_REBOOT_TYPE_NORMAL = 0x0002;

export const PICOBOOT_PACKET_SIZE = 32;
const ARGS_OFFSET = 16;
const ARGS_SIZE = 16;

function buildPacket(cmdId: number, cmdSize: number, transferLen: number, token: number, fillArgs: (view: DataView) => void): Uint8Array {
  const buf = new Uint8Array(PICOBOOT_PACKET_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, PICOBOOT_MAGIC >>> 0, true);
  view.setUint32(4, token >>> 0, true);
  buf[8] = cmdId & 0xff;
  buf[9] = cmdSize & 0xff;
  view.setUint16(10, 0, true);
  view.setUint32(12, transferLen >>> 0, true);
  // args region starts zeroed (Uint8Array default); fillArgs writes into
  // a view already offset so callers just address 0..15.
  const argsView = new DataView(buf.buffer, ARGS_OFFSET, ARGS_SIZE);
  fillArgs(argsView);
  return buf;
}

/** EXCLUSIVE_ACCESS: claim (or release) the flash bus. exclusive: 0=none, 1=exclusive, 2=exclusive+eject. */
export function buildExclusiveAccess(token: number, exclusive: 0 | 1 | 2 = 1): Uint8Array {
  return buildPacket(PICOBOOT_CMD.EXCLUSIVE_ACCESS, 1, 0, token, (v) => v.setUint8(0, exclusive));
}

/** EXIT_XIP: leave memory-mapped flash read mode so flash can be erased/written. No args. */
export function buildExitXip(token: number): Uint8Array {
  return buildPacket(PICOBOOT_CMD.EXIT_XIP, 0, 0, token, () => {});
}

/** FLASH_ERASE: erase `size` bytes starting at `addr`. Both must be 4096-byte sector aligned. */
export function buildFlashErase(token: number, addr: number, size: number): Uint8Array {
  return buildPacket(PICOBOOT_CMD.FLASH_ERASE, 8, 0, token, (v) => {
    v.setUint32(0, addr >>> 0, true);
    v.setUint32(4, size >>> 0, true);
  });
}

/** WRITE: write `size` bytes to `addr`; the caller sends `size` bytes on bulk OUT right after this packet. */
export function buildWrite(token: number, addr: number, size: number): Uint8Array {
  return buildPacket(PICOBOOT_CMD.WRITE, 8, size, token, (v) => {
    v.setUint32(0, addr >>> 0, true);
    v.setUint32(4, size >>> 0, true);
  });
}

/** REBOOT2 (RP2350): reboot with explicit flags (REBOOT2_FLAG_REBOOT_TYPE_NORMAL for a normal boot). */
export function buildReboot2(token: number, flags: number, delayMs: number, p0 = 0, p1 = 0): Uint8Array {
  return buildPacket(PICOBOOT_CMD.REBOOT2, 16, 0, token, (v) => {
    v.setUint32(0, flags >>> 0, true);
    v.setUint32(4, delayMs >>> 0, true);
    v.setUint32(8, p0 >>> 0, true);
    v.setUint32(12, p1 >>> 0, true);
  });
}

/** REBOOT (RP2040 and fallback): reboot to (pc, sp), or (0, 0) for the normal boot path. */
export function buildReboot(token: number, pc: number, sp: number, delayMs: number): Uint8Array {
  return buildPacket(PICOBOOT_CMD.REBOOT, 12, 0, token, (v) => {
    v.setUint32(0, pc >>> 0, true);
    v.setUint32(4, sp >>> 0, true);
    v.setUint32(8, delayMs >>> 0, true);
  });
}

// ---- WebUSB transport ---------------------------------------------------
//
// Everything below touches a real USBDevice and has no meaningful unit
// test without hardware; site/flasher/webusb.d.ts declares just enough of
// the WebUSB surface this file uses (there's no @types/w3c-web-usb
// dependency in this repo, and this repo takes no CDN/npm shortcuts on a
// public page).

export interface PicobootInterface {
  interfaceNumber: number;
  epIn: number;
  epOut: number;
}

/** Find the PICOBOOT vendor interface (class 0xFF) and its bulk endpoints on an opened, configured device. */
export function findPicobootInterface(device: USBDevice): PicobootInterface | null {
  const config = device.configuration;
  if (!config) return null;
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== 0xff) continue;
      const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
      const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (epIn && epOut) {
        return { interfaceNumber: iface.interfaceNumber, epIn: epIn.endpointNumber, epOut: epOut.endpointNumber };
      }
    }
  }
  return null;
}

export class PicobootProtocolError extends Error {}

/** Thin, stateful wrapper: owns the token counter and the claimed interface, sends commands, recovers from stalls. */
export class PicobootDevice {
  private iface: PicobootInterface | null = null;
  private token = 1;

  constructor(private readonly device: USBDevice) {}

  async open(): Promise<void> {
    if (!this.device.opened) await this.device.open();
    if (!this.device.configuration) await this.device.selectConfiguration(1);
    const iface = findPicobootInterface(this.device);
    if (!iface) throw new PicobootProtocolError("no PICOBOOT (class 0xFF, bulk in/out) interface found on this device");
    this.iface = iface;
    await this.device.claimInterface(iface.interfaceNumber);
  }

  async close(): Promise<void> {
    if (this.iface) {
      try {
        await this.device.releaseInterface(this.iface.interfaceNumber);
      } catch {
        // best effort: the device may already be gone (it just rebooted)
      }
    }
    try {
      await this.device.close();
    } catch {
      // same
    }
  }

  private nextToken(): number {
    const t = this.token;
    this.token = (this.token + 1) >>> 0;
    return t;
  }

  private requireIface(): PicobootInterface {
    if (!this.iface) throw new PicobootProtocolError("PicobootDevice.open() was not called (or failed) before use");
    return this.iface;
  }

  private async transferOutRecovering(data: Uint8Array): Promise<void> {
    const iface = this.requireIface();
    const result = await this.device.transferOut(iface.epOut, data);
    if (result.status === "stall") {
      await this.device.clearHalt("out", iface.epOut);
      throw new PicobootProtocolError("bulk OUT transfer stalled (halt cleared); the command was not accepted");
    }
  }

  private async readAck(): Promise<void> {
    const iface = this.requireIface();
    const result = await this.device.transferIn(iface.epIn, 64);
    if (result.status === "stall") {
      await this.device.clearHalt("in", iface.epIn);
      throw new PicobootProtocolError("bulk IN transfer stalled while waiting for acknowledge (halt cleared)");
    }
  }

  private async sendCommand(packet: Uint8Array, dataOut?: Uint8Array): Promise<void> {
    await this.transferOutRecovering(packet);
    if (dataOut && dataOut.length > 0) await this.transferOutRecovering(dataOut);
    await this.readAck();
  }

  async exclusiveAccess(exclusive: 0 | 1 | 2 = 1): Promise<void> {
    await this.sendCommand(buildExclusiveAccess(this.nextToken(), exclusive));
  }

  async exitXip(): Promise<void> {
    await this.sendCommand(buildExitXip(this.nextToken()));
  }

  async flashErase(addr: number, size: number): Promise<void> {
    await this.sendCommand(buildFlashErase(this.nextToken(), addr, size));
  }

  async write(addr: number, data: Uint8Array): Promise<void> {
    await this.sendCommand(buildWrite(this.nextToken(), addr, data.length), data);
  }

  /** RP2350 reboot; throws (does not fall back) so the caller (flash.ts) can decide the fallback policy. */
  async reboot2(flags: number, delayMs: number): Promise<void> {
    await this.sendCommand(buildReboot2(this.nextToken(), flags, delayMs));
  }

  /** RP2040-style reboot, used as the REBOOT2 fallback. */
  async reboot(pc: number, sp: number, delayMs: number): Promise<void> {
    await this.sendCommand(buildReboot(this.nextToken(), pc, sp, delayMs));
  }
}
