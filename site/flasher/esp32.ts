// site/flasher/esp32.ts: flash the ESP32-S3 pack's firmware onto the real
// board from the run page, over Web Serial, using Espressif's own esptool-js
// (Apache-2.0, pinned in package.json) as the protocol layer.
//
// This is the ESP32 counterpart of flash.ts, and the two are deliberately not
// the same shape underneath: the RP2350 path implements the PICOBOOT protocol
// itself (site/flasher/picoboot.ts) because it is a dozen commands over two
// bulk endpoints, while the ESP32 serial protocol has a ROM loader, a stub
// loader uploaded into RAM, SLIP framing, per-chip register maps and
// compression. Reimplementing that would be a worse copy of the thing
// Espressif already ships and tests. So this file owns the SEQUENCE and the
// error vocabulary; esptool-js owns the wire.
//
// Sequence: fetch the manifest -> plan the write -> fetch the merged image and
// check it against the MD5 the build recorded -> ask for a serial port (user
// gesture) -> hand it to esptool-js and let it detect the chip -> refuse
// anything that is not an ESP32-S3 by name -> write the image with MD5
// verification on -> reset the board into it.
//
// THE USB PATH. This board has native USB: its ESP32-S3 exposes a USB
// Serial/JTAG peripheral, and that is the one port the firmware logs and
// devlink both use (packs/esp32-s3-touch-amoled-18/docs/decisions/
// 0002-devlink-over-usb-serial-jtag.md, and sdkconfig.defaults'
// CONFIG_ESP_CONSOLE_USB_SERIAL_JTAG). There is no CP210x/CH34x bridge on this
// enclosure and no button ritual in the normal case: that peripheral maps the
// host's DTR and RTS lines onto GPIO0 (BOOT) and EN (reset), so esptool-js's
// UsbJtagSerialReset sequence walks the chip into the ROM download mode by
// itself. esptool-js picks that sequence automatically when the port's product
// id is Espressif's USB_JTAG_SERIAL_PID, so nothing here has to ask for it.
//
// That same DTR wiring is what decision 0002 warns about from the other
// direction: devlink has to be told DEVLINK_DTR=0, because a host that asserts
// DTR while talking to a RUNNING firmware is pulling its BOOT button. Here we
// want exactly that effect, which is why it is not a problem for the flasher
// and is one for the console.
import { ESPLoader, Transport } from "esptool-js";
import { md5Hex } from "./md5";
import { ManifestError, parseEsp32Manifest, planEsp32Write, type WritePlan } from "./esp32Manifest";

export type Esp32FlashPhase = "connecting" | "writing" | "rebooting" | "done";

export interface Esp32FlashProgress {
  phase: Esp32FlashPhase;
  /** 0-100, monotonically increasing across the whole flash cycle. */
  percent: number;
  message: string;
}

export type Esp32ProgressCallback = (progress: Esp32FlashProgress) => void;

export type Esp32FlashErrorCode =
  | "unsupported-browser"
  | "no-port-selected"
  | "bad-manifest"
  | "artifact-mismatch"
  | "wrong-chip"
  | "serial-error";

export class Esp32FlashError extends Error {
  constructor(
    message: string,
    readonly code: Esp32FlashErrorCode
  ) {
    super(message);
  }
}

/** True when this browser exposes navigator.serial at all (Chrome/Edge on desktop; not Firefox, not Safari, not mobile browsers). */
export function isWebSerialSupported(): boolean {
  return typeof navigator !== "undefined" && !!navigator.serial;
}

// The ROM loader's own baud rate, and the one we keep for the whole session.
//
// esptool-js changes baud rate whenever the `baudrate` it was constructed
// with differs from its `romBaudrate` (fixed at 115200 in its constructor,
// and not settable through LoaderOptions in 0.6.1), and its changeBaud() has
// no exception for a USB Serial/JTAG port, unlike esptool.py which skips the
// change there. On this board the "serial" link is a USB endpoint pair: the
// number is a fiction the peripheral ignores, so a higher one buys nothing,
// and the disconnect/reconnect dance around a fictional number is a real way
// to lose the port mid-flash. Passing 115200 means the two match and no
// change is ever attempted.
const ESP_BAUD = 115200;

// What the run page's own artifact index calls this chip, and what the ROM
// loader is expected to answer with. esptool-js's main() returns a chip
// description like "ESP32-S3 (QFN56) (revision v0.2)".
const EXPECTED_CHIP = "ESP32-S3";

/**
 * Reset the board out of the ROM/stub loader and into the firmware just
 * written, using esptool-js's custom-reset sequence rather than its
 * `after("hard_reset")`.
 *
 * Why not hard_reset: esptool-js's HardReset only DEASSERTS RTS (`sleep(100)`
 * then `setRTS(false)`), where esptool.py's own HardReset asserts it first and
 * then releases it - an actual pulse on EN. After a flash the chip is sitting
 * in the stub loader with EN already released, so the deassert-only version
 * changes nothing and the board stays in the loader instead of booting the
 * firmware. "R1|W100|R0" is esptool.py's pulse, expressed in esptool-js's own
 * reset-sequence mini-language (see its reset.ts CustomReset).
 */
const RESET_INTO_FIRMWARE = "R1|W100|R0";

async function fetchJson(url: string): Promise<unknown> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Esp32FlashError(`Could not fetch ${url}: HTTP ${resp.status}.`, "bad-manifest");
  try {
    return await resp.json();
  } catch {
    throw new Esp32FlashError(`${url} is not valid JSON.`, "bad-manifest");
  }
}

/**
 * Read the artifact index and work out what to write for `imageId`.
 * Everything a malformed manifest can do stops here, as a "bad-manifest"
 * error, which is a deploy problem and worth naming as one rather than
 * blaming the board for it.
 */
export async function loadWritePlan(manifestUrl: string, imageId: string): Promise<WritePlan> {
  const raw = await fetchJson(manifestUrl);
  const baseHref = manifestUrl.slice(0, manifestUrl.lastIndexOf("/") + 1);
  try {
    return planEsp32Write(parseEsp32Manifest(raw), imageId, baseHref);
  } catch (err) {
    if (err instanceof ManifestError) throw new Esp32FlashError(err.message, "bad-manifest");
    throw err;
  }
}

/**
 * Fetch one planned image and check it against the MD5 the build recorded.
 *
 * This is not the same check as the one esptool-js does during the write
 * (which compares what the chip read back against what the browser sent). It
 * catches a truncated or stale artifact BEFORE the board is touched, which is
 * the difference between a clear message and a board left half-written.
 */
async function fetchImage(url: string, expectedMd5: string, expectedBytes: number): Promise<Uint8Array> {
  const resp = await fetch(url);
  if (!resp.ok) throw new Esp32FlashError(`Could not fetch the firmware image (${url}): HTTP ${resp.status}.`, "artifact-mismatch");
  const bytes = new Uint8Array(await resp.arrayBuffer());
  if (bytes.byteLength !== expectedBytes) {
    throw new Esp32FlashError(
      `The firmware image is ${bytes.byteLength} bytes but the artifact index says ${expectedBytes}. This page is serving a stale or truncated build; nothing was written to the board.`,
      "artifact-mismatch"
    );
  }
  const actual = md5Hex(bytes);
  if (actual !== expectedMd5) {
    throw new Esp32FlashError(
      `The firmware image does not match its recorded checksum (${actual} vs ${expectedMd5}). This page is serving a corrupted build; nothing was written to the board.`,
      "artifact-mismatch"
    );
  }
  return bytes;
}

/** Show the browser's serial port picker. Requires a user gesture, which is why it lives on the click path and not in any preflight. */
async function requestSerialPort(): Promise<SerialPort> {
  if (!isWebSerialSupported()) {
    throw new Esp32FlashError("This browser doesn't support Web Serial. Use Chrome or Edge on desktop.", "unsupported-browser");
  }
  try {
    // No filters: the ESP32-S3's USB Serial/JTAG port is the obvious entry,
    // but a board that came up under a different USB descriptor (or through
    // a hub that reports its own ids) would then be missing from the list
    // with no way for the human to pick it. Everything downstream identifies
    // the chip by asking it, not by its USB ids.
    return await navigator.serial!.requestPort();
  } catch {
    throw new Esp32FlashError(
      "No serial port was selected. Plug the board in over USB and pick its port in the browser's list; if it doesn't appear at all, see the download-mode ritual below.",
      "no-port-selected"
    );
  }
}

/**
 * Flash one image from the artifact index onto the connected board.
 *
 * `manifestUrl` and `imageId` are read off the run page's own flash section by
 * flash-ui.ts; this function owns the whole serial session from the picker to
 * the reset.
 */
export async function flashEsp32(manifestUrl: string, imageId: string, onProgress: Esp32ProgressCallback): Promise<void> {
  onProgress({ phase: "connecting", percent: 0, message: "Reading the artifact index…" });
  const plan = await loadWritePlan(manifestUrl, imageId);

  onProgress({ phase: "connecting", percent: 2, message: "Fetching firmware image…" });
  const files: { data: Uint8Array; address: number }[] = [];
  for (const write of plan.writes) {
    files.push({ data: await fetchImage(write.url, write.md5, write.bytes), address: write.address });
  }

  onProgress({ phase: "connecting", percent: 6, message: "Requesting the board's serial port…" });
  const port = await requestSerialPort();

  const transport = new Transport(port, false);
  const loader = new ESPLoader({ transport, baudrate: ESP_BAUD });
  let opened = false;
  try {
    onProgress({ phase: "connecting", percent: 8, message: "Waking the bootloader…" });
    let chip: string;
    try {
      chip = await loader.main();
    } catch (err) {
      // esptool-js says "Failed to connect with the device" here, which is
      // true and useless: from the human's side this is either the wrong port
      // in the picker or firmware that will not hand the USB peripheral over,
      // and those have different answers. Both are named.
      const detail = err instanceof Error ? err.message : String(err);
      throw new Esp32FlashError(
        `No bootloader answered on that port (${detail}). Check the port you picked is the board's own USB port, and if it still does not answer, use the download-mode ritual below.`,
        "serial-error"
      );
    }
    opened = true;
    if (!chip.toUpperCase().includes(EXPECTED_CHIP)) {
      throw new Esp32FlashError(
        `That port answered as "${chip}". This firmware is built for the ${EXPECTED_CHIP} (a different chip) and won't run on it.`,
        "wrong-chip"
      );
    }
    onProgress({ phase: "writing", percent: 10, message: `Found ${chip}` });

    await loader.writeFlash({
      fileArray: files,
      flashSize: plan.flashSize,
      flashMode: plan.flashMode,
      flashFreq: plan.flashFreq,
      // Only the region this image covers is erased, not the whole 16MB
      // chip: the merged image starts at the bootloader and runs past the
      // end of the app partition, so everything that makes the board boot is
      // replaced, and a full-chip erase would only add tens of seconds.
      eraseAll: false,
      compress: true,
      // The merged image is mostly the app, but the gap ESP-IDF leaves
      // between the partition table and the app is 0xFF filler that
      // compresses to nothing - which is half of why one merged file costs
      // no more on the wire than three parts (the other half is in
      // build-native.ts's header).
      calculateMD5Hash: (image: Uint8Array) => md5Hex(image),
      reportProgress: (_fileIndex: number, written: number, total: number) => {
        const pct = total > 0 ? written / total : 0;
        onProgress({
          phase: "writing",
          percent: 10 + Math.round(pct * 85),
          message: `Writing ${Math.round(pct * 100)}%`,
        });
      },
    });

    onProgress({ phase: "rebooting", percent: 96, message: "Rebooting into the new firmware…" });
    await loader.after("custom_reset", false, RESET_INTO_FIRMWARE);
    onProgress({ phase: "done", percent: 100, message: "Done. The board is rebooting into the new firmware." });
  } catch (err) {
    if (err instanceof Esp32FlashError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new Esp32FlashError(`Serial error while flashing: ${message}`, "serial-error");
  } finally {
    // The port is ours until it is given back: a page that keeps it locked
    // makes the next attempt (and any serial console) fail with a confusing
    // "port already open". Failing to disconnect is not worth surfacing over
    // whatever error is already on its way up.
    try {
      if (opened || transport.device.readable) await transport.disconnect();
    } catch {
      // nothing useful to do here
    }
  }
}
