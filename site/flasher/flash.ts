// site/flasher/flash.ts: orchestrates flashing a parsed .uf2 onto a real
// RP2350 board over WebUSB, using picoboot.ts's protocol primitives and
// uf2.ts's parser. This is the only file that sequences the actual flash
// cycle; flash-ui.ts just calls flashUf2() and renders whatever progress
// callback it gets.
//
// Sequence: request a device -> refuse it up front if it's the wrong chip
// family -> open + claim the PICOBOOT interface -> take exclusive access
// -> exit XIP (flash isn't erasable/writable while memory-mapped for
// execute-in-place reads) -> erase every 4096-byte sector the image's
// flash range touches -> write every UF2 block's payload -> reboot
// (REBOOT2, RP2350's own command, falling back to the RP2040-era REBOOT if
// REBOOT2 doesn't get acknowledged) -> close.
import { FAMILY_RP2350_ARM_S, FLASH_SECTOR_SIZE, computeFlashPlan, parseUf2 } from "./uf2";
import { PicobootDevice, PicobootProtocolError, REBOOT2_FLAG_REBOOT_TYPE_NORMAL } from "./picoboot";

// Raspberry Pi's USB vendor ID, and the two BOOTSEL product IDs that
// matter here: RP2350's own (what we want) and RP2040's (what we refuse,
// with a specific message, rather than silently trying and failing deep
// into the flash cycle).
const RPI_VENDOR_ID = 0x2e8a;
const RP2350_BOOTSEL_PRODUCT_ID = 0x000f;
const RP2040_BOOTSEL_PRODUCT_ID = 0x0003;

const REBOOT_DELAY_MS = 500;

export type FlashPhase = "connecting" | "erasing" | "writing" | "rebooting" | "done";

export interface FlashProgress {
  phase: FlashPhase;
  /** 0-100, monotonically increasing across the whole flash cycle. */
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: FlashProgress) => void;

export type FlashErrorCode = "unsupported-browser" | "no-device-selected" | "wrong-chip-family" | "usb-error";

export class FlashError extends Error {
  constructor(
    message: string,
    readonly code: FlashErrorCode
  ) {
    super(message);
  }
}

/** True when this browser exposes navigator.usb at all (Chrome/Edge on desktop; not Firefox, not Safari, not mobile browsers). */
export function isWebUsbSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.usb;
}

/**
 * Show the browser's device picker and validate the choice. Throws
 * FlashError with a code the UI can key off of:
 *   - "unsupported-browser": no navigator.usb at all.
 *   - "no-device-selected": the picker was cancelled or nothing matched,
 *     which from here is indistinguishable from "the board isn't in
 *     BOOTSEL mode yet" - that's the message we show.
 *   - "wrong-chip-family": an RP2040 BOOTSEL device was chosen; this
 *     flasher only ever writes rp2350-arm-s images.
 */
export async function requestPicobootDevice(): Promise<USBDevice> {
  if (!isWebUsbSupported()) {
    throw new FlashError("This browser doesn't support WebUSB. Use Chrome or Edge on desktop.", "unsupported-browser");
  }
  let device: USBDevice;
  try {
    device = await navigator.usb!.requestDevice({
      filters: [
        { vendorId: RPI_VENDOR_ID, productId: RP2350_BOOTSEL_PRODUCT_ID },
        { vendorId: RPI_VENDOR_ID, productId: RP2040_BOOTSEL_PRODUCT_ID },
      ],
    });
  } catch {
    // requestDevice() rejects both when the user cancels the picker and
    // when nothing matched the filters - i.e. no board is in BOOTSEL mode.
    // Same message either way: point at the ritual.
    throw new FlashError("No device was selected. The board isn't in BOOTSEL mode yet: see the entry ritual below.", "no-device-selected");
  }
  if (device.productId === RP2040_BOOTSEL_PRODUCT_ID) {
    throw new FlashError(
      "That's an RP2040 BOOTSEL device. This .uf2 is built for RP2350 (a different chip family) and won't run on it.",
      "wrong-chip-family"
    );
  }
  return device;
}

/**
 * Flash a parsed rp2350-arm-s UF2 image onto the connected device,
 * reporting progress as it goes. `uf2Bytes` is the raw file content
 * (fetched same-origin by the caller); this function owns the whole USB
 * session, including opening the device picker.
 */
export async function flashUf2(uf2Bytes: Uint8Array, onProgress: ProgressCallback): Promise<void> {
  onProgress({ phase: "connecting", percent: 0, message: "Requesting device…" });
  const device = await requestPicobootDevice();

  const { blocks } = parseUf2(uf2Bytes);
  const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);

  const pb = new PicobootDevice(device);
  try {
    onProgress({ phase: "connecting", percent: 3, message: "Opening device…" });
    await pb.open();

    onProgress({ phase: "connecting", percent: 6, message: "Claiming exclusive flash access…" });
    await pb.exclusiveAccess(1);
    await pb.exitXip();

    const sectorAddrs: number[] = [];
    for (let addr = plan.eraseStart; addr < plan.eraseEnd; addr += FLASH_SECTOR_SIZE) sectorAddrs.push(addr);

    for (let i = 0; i < sectorAddrs.length; i++) {
      await pb.flashErase(sectorAddrs[i]!, FLASH_SECTOR_SIZE);
      const pct = 10 + Math.round(((i + 1) / sectorAddrs.length) * 30);
      onProgress({ phase: "erasing", percent: pct, message: `Erasing sector ${i + 1}/${sectorAddrs.length}` });
    }

    for (let i = 0; i < plan.chunks.length; i++) {
      const chunk = plan.chunks[i]!;
      await pb.write(chunk.addr, chunk.data);
      const donePct = Math.round(((i + 1) / plan.chunks.length) * 100);
      const pct = 40 + Math.round(((i + 1) / plan.chunks.length) * 55);
      onProgress({ phase: "writing", percent: pct, message: `Writing ${donePct}%` });
    }

    onProgress({ phase: "rebooting", percent: 97, message: "Rebooting into the new firmware…" });
    try {
      await pb.reboot2(REBOOT2_FLAG_REBOOT_TYPE_NORMAL, REBOOT_DELAY_MS);
    } catch (err) {
      if (!(err instanceof PicobootProtocolError)) throw err;
      // REBOOT2 stalled or wasn't acknowledged: fall back to the
      // RP2040-era REBOOT command, which every PICOBOOT device speaks.
      await pb.reboot(0, 0, REBOOT_DELAY_MS);
    }
    onProgress({ phase: "done", percent: 100, message: "Done. The board is rebooting into the new firmware." });
  } catch (err) {
    if (err instanceof FlashError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new FlashError(`USB error while flashing: ${message}`, "usb-error");
  } finally {
    await pb.close();
  }
}
