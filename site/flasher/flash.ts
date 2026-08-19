// site/flasher/flash.ts: orchestrates flashing a parsed .uf2 onto a real
// RP2350 board over WebUSB, using picoboot.ts's protocol primitives and
// uf2.ts's parser. This is the only file that sequences the actual flash
// cycle; flash-ui.ts just calls flashUf2() and renders whatever progress
// callback it gets.
//
// Sequence: request a device -> refuse it up front if it's the wrong chip
// family -> if it's a RUNNING puck rather than a BOOTSEL device, ask its
// firmware to reboot into BOOTSEL and wait for it to come back (see "The
// running device" below) -> open + claim the PICOBOOT interface -> take
// exclusive access -> exit XIP (flash isn't erasable/writable while
// memory-mapped for execute-in-place reads) -> erase the image's flash
// range, in as few FLASH_ERASE commands as PICOBOOT_MAX_ERASE_SPAN allows
// -> write every UF2 block's payload, coalesced into as few WRITE commands
// as PICOBOOT_MAX_WRITE_SIZE allows (each UF2 block is only 256 bytes; one
// WRITE per block was the dominant cost here, all round-trip latency and
// no bandwidth) -> reboot (REBOOT2, RP2350's own command, falling back to
// the RP2040-era REBOOT if REBOOT2 doesn't get acknowledged) -> close.
//
// THE RUNNING DEVICE. A board that is running puck firmware is not a
// BOOTSEL device and speaks no PICOBOOT at all: it enumerates as
// 2E8A:0009, a pico-sdk CDC device (two CDC interfaces, plus the vendor
// reset interface described below). Until this file learned about it, the
// only way in was the physical ritual (unplug, hold PWR twelve seconds,
// hold BOOT while replugging), which is a lot to ask of a page whose whole
// promise is "click to flash".
//
// pico-sdk exposes a standard way out of that, and the firmware pins it on
// (packs/rp2350-touch-amoled-18/firmware/CMakeLists.txt's
// PICO_ENABLE_USB_RESET_VIA_VENDOR_INTERFACE block): a third USB
// interface, class 0xFF / subclass 0x00 / protocol 0x01, no endpoints,
// whose RESET_REQUEST_BOOTSEL control request calls the bootrom's
// rom_reset_usb_boot_extra() and never returns. It is what `picotool load
// -f` uses over libusb. The browser reaches the same interface with
// claimInterface + controlTransferOut, so the reboot costs one control
// transfer and the device re-enumerates as 2E8A:000F a moment later.
//
// The device that comes back is, to WebUSB, a DIFFERENT device with its
// own permission: navigator.usb.getDevices() surfaces it silently only if
// this origin was already granted access to it before (a previous flash
// from this page). When it doesn't, a second requestDevice() is the only
// way, and that needs a user gesture the wait for re-enumeration has
// usually already outlived - which is why the second prompt is attempted
// and, when the browser refuses it, turned into a message telling the
// human to click Flash again rather than into a stack trace.
import { FAMILY_RP2350_ARM_S, coalesceWriteRuns, computeFlashPlan, parseUf2, planEraseSpans } from "./uf2";
import { PicobootDevice, PicobootProtocolError, REBOOT2_FLAG_REBOOT_TYPE_NORMAL } from "./picoboot";

// Raspberry Pi's USB vendor ID, and the three product IDs that matter
// here: RP2350's BOOTSEL id (what we want), RP2040's BOOTSEL id (what we
// refuse, with a specific message, rather than silently trying and failing
// deep into the flash cycle), and the id a running puck enumerates under.
export const RPI_VENDOR_ID = 0x2e8a;
export const RP2350_BOOTSEL_PRODUCT_ID = 0x000f;
export const RP2040_BOOTSEL_PRODUCT_ID = 0x0003;
// pico-sdk's own CDC product id for a non-RP2040 part (USBD_PID in
// pico_stdio_usb/stdio_usb_descriptors.c: 0x0009 for RP2350, 0x000a for
// RP2040). This firmware does not override it, so a running puck is
// 2E8A:0009 - read out of the linked image's device descriptor, not
// guessed. Nothing distinguishes it on the wire from any other pico-sdk
// CDC application, which is fine: the reset request either finds a reset
// interface and works, or doesn't and says so.
export const PUCK_RUNNING_PRODUCT_ID = 0x0009;

// The reset interface, per pico-sdk's pico/usb_reset_interface.h. Class is
// TinyUSB's TUSB_CLASS_VENDOR_SPECIFIC; subclass and protocol are what
// pico_usb_reset's usb_reset_interface_open() verifies before adopting an
// interface, so they are the identification, not the vendor/product pair.
export const RESET_INTERFACE_CLASS = 0xff;
export const RESET_INTERFACE_SUBCLASS = 0x00;
export const RESET_INTERFACE_PROTOCOL = 0x01;
/** RESET_REQUEST_BOOTSEL: reboot into BOOTSEL mode. (0x02 is RESET_REQUEST_FLASH, a normal reboot, which this flasher never needs.) */
export const RESET_REQUEST_BOOTSEL = 0x01;

// How long to wait for the rebooted board to come back as a BOOTSEL
// device, and how often to look. A real RP2350 re-enumerates in well under
// a second; ten seconds is margin for a hub, a slow host stack, or a
// board that was mid-frame when the request landed.
const BOOTSEL_REENUMERATE_TIMEOUT_MS = 10000;
const BOOTSEL_POLL_INTERVAL_MS = 250;

const REBOOT_DELAY_MS = 500;

export type FlashPhase = "connecting" | "entering-bootsel" | "erasing" | "writing" | "rebooting" | "done";

export interface FlashProgress {
  phase: FlashPhase;
  /** 0-100, monotonically increasing across the whole flash cycle. */
  percent: number;
  message: string;
}

export type ProgressCallback = (progress: FlashProgress) => void;

export type FlashErrorCode =
  | "unsupported-browser"
  | "no-device-selected"
  | "wrong-chip-family"
  | "no-reset-interface"
  | "bootsel-reselect-needed"
  | "usb-error";

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
 * What a chosen (or enumerated) USB device is, decided from its
 * vendor/product pair alone. Pure, so the whole classification table is a
 * unit test rather than something only a bench session can check.
 *
 *   - "bootsel-rp2350": already in BOOTSEL, speaks PICOBOOT, flash it.
 *   - "bootsel-rp2040": BOOTSEL, wrong chip family, refuse it by name.
 *   - "running-puck":   running firmware, needs the reset request first.
 *   - "unknown":        anything else the picker somehow returned.
 */
export type DeviceKind = "bootsel-rp2350" | "bootsel-rp2040" | "running-puck" | "unknown";

export function classifyDevice(device: { vendorId: number; productId: number }): DeviceKind {
  if (device.vendorId !== RPI_VENDOR_ID) return "unknown";
  if (device.productId === RP2350_BOOTSEL_PRODUCT_ID) return "bootsel-rp2350";
  if (device.productId === RP2040_BOOTSEL_PRODUCT_ID) return "bootsel-rp2040";
  if (device.productId === PUCK_RUNNING_PRODUCT_ID) return "running-puck";
  return "unknown";
}

/** The three filters the picker offers: both BOOTSEL ids, plus a running puck. */
export function deviceFilters(): USBDeviceFilter[] {
  return [
    { vendorId: RPI_VENDOR_ID, productId: RP2350_BOOTSEL_PRODUCT_ID },
    { vendorId: RPI_VENDOR_ID, productId: RP2040_BOOTSEL_PRODUCT_ID },
    { vendorId: RPI_VENDOR_ID, productId: PUCK_RUNNING_PRODUCT_ID },
  ];
}

/**
 * The setup packet of the reboot-to-BOOTSEL control transfer, as the five
 * fields WebUSB's controlTransferOut() takes. Separated from the transfer
 * itself so encodeSetupPacket() below can turn it into the eight bytes
 * that actually go on the wire, and a test can pin those bytes without a
 * device anywhere near it.
 *
 * requestType is "class", not "vendor", even though the interface is a
 * VENDOR-class one: that is what picotool sends over libusb
 * (LIBUSB_REQUEST_TYPE_CLASS | LIBUSB_RECIPIENT_INTERFACE), and matching
 * the traffic a proven client already produces is worth more than matching
 * the interface's own class byte. TinyUSB routes any interface-recipient
 * control request to whichever driver owns that interface number
 * (usbd.c's TUSB_REQ_RCPT_INTERFACE case forwards STD and class alike), so
 * "vendor" would reach usb_reset_interface_control_xfer_cb() too; there is
 * simply no reason to differ.
 *
 * wValue is 0. pico_usb_reset ORs its low two bits into the bootrom's
 * disable_interface_mask (bit 0 mass storage, bit 1 PICOBOOT) and reads
 * bit 8 as "an activity LED GPIO follows", so zero means "disable nothing,
 * drive no LED" - the absent-argument case the firmware must support, and
 * the only one this flasher wants: it needs PICOBOOT alive on the far side.
 *
 * wIndex is the reset interface's own number, which the firmware compares
 * against the interface it was opened as. It is discovered from the
 * descriptors (findResetInterface below), never assumed to be 2.
 */
export interface ControlSetup {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}

export function buildBootselResetSetup(interfaceNumber: number): ControlSetup {
  return {
    requestType: "class",
    recipient: "interface",
    request: RESET_REQUEST_BOOTSEL,
    value: 0x0000,
    index: interfaceNumber,
  };
}

const REQUEST_TYPE_BITS = { standard: 0, class: 1, vendor: 2 } as const;
const RECIPIENT_BITS = { device: 0, interface: 1, endpoint: 2, other: 3 } as const;

/**
 * The eight bytes of a USB SETUP packet for `setup`, in wire order:
 * bmRequestType, bRequest, wValue (LE), wIndex (LE), wLength (LE).
 * The browser builds this itself and never hands it back, so this exists
 * purely to make the framing checkable: golden bytes in a test are the
 * only thing standing between "we send a control transfer" and "we send
 * the RIGHT control transfer" on a change nobody can try on hardware.
 * Direction is always host-to-device here (bit 7 clear), because the only
 * transfer this file builds is an OUT with no data stage.
 */
export function encodeSetupPacket(setup: ControlSetup, wLength = 0): Uint8Array {
  const bmRequestType = (REQUEST_TYPE_BITS[setup.requestType] << 5) | RECIPIENT_BITS[setup.recipient];
  const out = new Uint8Array(8);
  out[0] = bmRequestType & 0xff;
  out[1] = setup.request & 0xff;
  out[2] = setup.value & 0xff;
  out[3] = (setup.value >> 8) & 0xff;
  out[4] = setup.index & 0xff;
  out[5] = (setup.index >> 8) & 0xff;
  out[6] = wLength & 0xff;
  out[7] = (wLength >> 8) & 0xff;
  return out;
}

/**
 * Find the reset interface on an opened, configured device: vendor class,
 * the reset subclass and protocol, and no endpoints (it is control-only).
 * Returns its interface number, or null when this device does not have one
 * - which is exactly the case of a board running firmware built before
 * 2026-08-19, and is reported as such rather than as a USB error.
 */
export function findResetInterface(device: USBDevice): number | null {
  const config = device.configuration;
  if (!config) return null;
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== RESET_INTERFACE_CLASS) continue;
      if (alt.interfaceSubclass !== RESET_INTERFACE_SUBCLASS) continue;
      if (alt.interfaceProtocol !== RESET_INTERFACE_PROTOCOL) continue;
      if (alt.endpoints.length !== 0) continue;
      return iface.interfaceNumber;
    }
  }
  return null;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Ask a RUNNING board to reboot into BOOTSEL, over its reset interface.
 *
 * Everything after the control transfer is best effort by construction:
 * the firmware's handler calls into the bootrom and never returns, so the
 * device disappears mid-transfer. Whether that surfaces as a resolved
 * promise, a "stall" status or a rejected NetworkError depends on the host
 * USB stack and the timing, and none of the three means the reboot failed.
 * The only honest test of success is whether a BOOTSEL device shows up
 * afterwards, which is waitForBootselDevice()'s job, so this function
 * swallows transfer and teardown failures and lets that decide.
 */
export async function rebootRunningDeviceToBootsel(device: USBDevice): Promise<void> {
  if (!device.opened) await device.open();
  if (!device.configuration) await device.selectConfiguration(1);
  const interfaceNumber = findResetInterface(device);
  if (interfaceNumber === null) {
    try {
      await device.close();
    } catch {
      // nothing useful to do; the message below is the point
    }
    throw new FlashError(
      "This board is running firmware with no USB reset interface, so it can't be rebooted into BOOTSEL from here. " +
        "That's firmware built before 2026-08-19: use the BOOTSEL entry ritual below once, and every flash after that is a click.",
      "no-reset-interface"
    );
  }
  await device.claimInterface(interfaceNumber);
  try {
    await device.controlTransferOut(buildBootselResetSetup(interfaceNumber));
  } catch {
    // Expected on most hosts: see this function's comment.
  }
  try {
    await device.releaseInterface(interfaceNumber);
  } catch {
    // the device is already gone if the reboot took
  }
  try {
    await device.close();
  } catch {
    // same
  }
}

/**
 * Poll the devices this origin has already been granted for one that came
 * back in BOOTSEL mode. getDevices() only ever returns previously
 * authorized devices, so this succeeds when the same board has been
 * flashed from this page before and silently returns null the first time,
 * which is the caller's cue to ask for a second pick.
 */
export async function waitForBootselDevice(
  timeoutMs = BOOTSEL_REENUMERATE_TIMEOUT_MS,
  pollMs = BOOTSEL_POLL_INTERVAL_MS
): Promise<USBDevice | null> {
  if (!isWebUsbSupported()) return null;
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    let devices: USBDevice[] = [];
    try {
      devices = await navigator.usb!.getDevices();
    } catch {
      devices = [];
    }
    const found = devices.find((d) => classifyDevice(d) === "bootsel-rp2350");
    if (found) return found;
    if (Date.now() >= deadline) return null;
    await delay(pollMs);
  }
}

/**
 * Show the browser's device picker and validate the choice. Throws
 * FlashError with a code the UI can key off of:
 *   - "unsupported-browser": no navigator.usb at all.
 *   - "no-device-selected": the picker was cancelled or nothing matched,
 *     which from here is indistinguishable from "no board is plugged in" -
 *     that's the message we show.
 *   - "wrong-chip-family": an RP2040 BOOTSEL device was chosen; this
 *     flasher only ever writes rp2350-arm-s images.
 */
export async function requestPicobootDevice(): Promise<USBDevice> {
  if (!isWebUsbSupported()) {
    throw new FlashError("This browser doesn't support WebUSB. Use Chrome or Edge on desktop.", "unsupported-browser");
  }
  let device: USBDevice;
  try {
    device = await navigator.usb!.requestDevice({ filters: deviceFilters() });
  } catch {
    // requestDevice() rejects both when the user cancels the picker and
    // when nothing matched the filters - i.e. no board is plugged in at
    // all. Same message either way.
    throw new FlashError(
      "No device was selected. Plug the board in over USB and pick it in the browser's device list; if it doesn't appear at all, see the BOOTSEL entry ritual below.",
      "no-device-selected"
    );
  }
  if (classifyDevice(device) === "bootsel-rp2040") {
    throw new FlashError(
      "That's an RP2040 BOOTSEL device. This .uf2 is built for RP2350 (a different chip family) and won't run on it.",
      "wrong-chip-family"
    );
  }
  return device;
}

/**
 * Get a device that speaks PICOBOOT, rebooting a running board into
 * BOOTSEL first if that is what was picked. Returns as soon as it holds a
 * BOOTSEL device; every other outcome is a FlashError with a code the UI
 * renders verbatim.
 */
export async function acquirePicobootDevice(onProgress: ProgressCallback): Promise<USBDevice> {
  const picked = await requestPicobootDevice();
  if (classifyDevice(picked) !== "running-puck") return picked;

  onProgress({ phase: "entering-bootsel", percent: 1, message: "Rebooting the device into BOOTSEL…" });
  await rebootRunningDeviceToBootsel(picked);

  onProgress({ phase: "entering-bootsel", percent: 2, message: "Waiting for the board to come back…" });
  const reenumerated = await waitForBootselDevice();
  if (reenumerated) return reenumerated;

  // The board rebooted but this origin has never been granted the BOOTSEL
  // device, so only a picker can hand it over. That picker needs a user
  // gesture, and the wait above has very likely outlived this click's - so
  // the failure is expected, and the message says what to do about it
  // rather than reporting a browser exception.
  onProgress({ phase: "entering-bootsel", percent: 2, message: "Device rebooted to BOOTSEL, select it again…" });
  try {
    const again = await navigator.usb!.requestDevice({
      filters: [{ vendorId: RPI_VENDOR_ID, productId: RP2350_BOOTSEL_PRODUCT_ID }],
    });
    if (classifyDevice(again) === "bootsel-rp2350") return again;
  } catch {
    // fall through to the message below
  }
  throw new FlashError(
    "The board rebooted into BOOTSEL, but this page needs permission for it as a new USB device. Click Flash over USB again and pick the RP2 Boot device.",
    "bootsel-reselect-needed"
  );
}

/**
 * Flash a parsed rp2350-arm-s UF2 image onto the connected device,
 * reporting progress as it goes. `uf2Bytes` is the raw file content
 * (fetched same-origin by the caller); this function owns the whole USB
 * session, including opening the device picker.
 */
export async function flashUf2(uf2Bytes: Uint8Array, onProgress: ProgressCallback): Promise<void> {
  onProgress({ phase: "connecting", percent: 0, message: "Requesting device…" });
  // Either the picked device already speaks PICOBOOT, or this rebooted a
  // running board into BOOTSEL and came back with the device that does.
  const device = await acquirePicobootDevice(onProgress);

  const { blocks } = parseUf2(uf2Bytes);
  const plan = computeFlashPlan(blocks, FAMILY_RP2350_ARM_S);

  const pb = new PicobootDevice(device);
  try {
    onProgress({ phase: "connecting", percent: 3, message: "Opening device…" });
    await pb.open();

    onProgress({ phase: "connecting", percent: 6, message: "Claiming exclusive flash access…" });
    await pb.exclusiveAccess(1);
    await pb.exitXip();

    // One FLASH_ERASE per span (normally just one span: a real image's
    // erase range is well under PICOBOOT_MAX_ERASE_SPAN) instead of one
    // per 4096-byte sector.
    const eraseSpans = planEraseSpans(plan.eraseStart, plan.eraseEnd);
    for (let i = 0; i < eraseSpans.length; i++) {
      const span = eraseSpans[i]!;
      await pb.flashErase(span.addr, span.size);
      const pct = 10 + Math.round(((i + 1) / eraseSpans.length) * 30);
      onProgress({ phase: "erasing", percent: pct, message: `Erasing ${i + 1}/${eraseSpans.length}` });
    }

    // One WRITE per coalesced run (contiguous UF2 chunks merged up to
    // PICOBOOT_MAX_WRITE_SIZE) instead of one per 256-byte UF2 block: a
    // ~190KB image drops from ~380 WRITE round-trips to a handful.
    const writeRuns = coalesceWriteRuns(plan.chunks);
    for (let i = 0; i < writeRuns.length; i++) {
      const run = writeRuns[i]!;
      await pb.write(run.addr, run.data);
      const donePct = Math.round(((i + 1) / writeRuns.length) * 100);
      const pct = 40 + Math.round(((i + 1) / writeRuns.length) * 55);
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
