// site/flasher/uf2.ts
var UF2_MAGIC_START0 = 171066965;
var UF2_MAGIC_START1 = 2656915799;
var UF2_MAGIC_END = 179400496;
var UF2_FLAG_FAMILY_ID_PRESENT = 8192;
var FAMILY_RP2350_ARM_S = 3834380121;
var UF2_BLOCK_SIZE = 512;
var UF2_DATA_AREA_SIZE = 476;
var FLASH_SECTOR_SIZE = 4096;
var PICOBOOT_MAX_WRITE_SIZE = 32768;
var PICOBOOT_MAX_ERASE_SPAN = 256 * 1024;

class Uf2ParseError extends Error {
}
function parseUf2Blocks(bytes) {
  if (bytes.length === 0 || bytes.length % UF2_BLOCK_SIZE !== 0) {
    throw new Uf2ParseError(`UF2 file size ${bytes.length} is not a nonzero multiple of ${UF2_BLOCK_SIZE}`);
  }
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const count = bytes.length / UF2_BLOCK_SIZE;
  const blocks = [];
  for (let i = 0;i < count; i++) {
    const base = i * UF2_BLOCK_SIZE;
    const magic0 = view.getUint32(base + 0, true);
    const magic1 = view.getUint32(base + 4, true);
    const magicEnd = view.getUint32(base + 508, true);
    if (magic0 !== UF2_MAGIC_START0 || magic1 !== UF2_MAGIC_START1) {
      throw new Uf2ParseError(`block ${i}: bad start magic (0x${magic0.toString(16)} 0x${magic1.toString(16)})`);
    }
    if (magicEnd !== UF2_MAGIC_END) {
      throw new Uf2ParseError(`block ${i}: bad end magic (0x${magicEnd.toString(16)})`);
    }
    const flags = view.getUint32(base + 8, true);
    const targetAddr = view.getUint32(base + 12, true);
    const payloadSize = view.getUint32(base + 16, true);
    const blockNo = view.getUint32(base + 20, true);
    const numBlocks = view.getUint32(base + 24, true);
    const familyOrFileSize = view.getUint32(base + 28, true);
    if (payloadSize > UF2_DATA_AREA_SIZE) {
      throw new Uf2ParseError(`block ${i}: payloadSize ${payloadSize} exceeds the ${UF2_DATA_AREA_SIZE}-byte data area`);
    }
    const payload = bytes.slice(base + 32, base + 32 + payloadSize);
    blocks.push({
      index: i,
      flags,
      targetAddr,
      payloadSize,
      blockNo,
      numBlocks,
      familyId: flags & UF2_FLAG_FAMILY_ID_PRESENT ? familyOrFileSize : null,
      payload
    });
  }
  return blocks;
}
function groupByFamily(blocks) {
  const groups = new Map;
  for (const b of blocks) {
    const key = b.familyId ?? -1;
    const list = groups.get(key);
    if (list)
      list.push(b);
    else
      groups.set(key, [b]);
  }
  return groups;
}
function alignDown(addr, align) {
  return addr - addr % align;
}
function alignUp(addr, align) {
  const rem = addr % align;
  return rem === 0 ? addr : addr + (align - rem);
}
function computeFlashPlan(blocks, familyId) {
  const family = blocks.filter((b) => b.familyId === familyId);
  if (family.length === 0) {
    throw new Uf2ParseError(`no blocks found for family 0x${familyId.toString(16)}`);
  }
  const sorted = [...family].sort((a, b) => a.blockNo - b.blockNo);
  const numBlocks = sorted[0].numBlocks;
  for (let i = 0;i < sorted.length; i++) {
    const b = sorted[i];
    if (b.numBlocks !== numBlocks) {
      throw new Uf2ParseError(`family 0x${familyId.toString(16)}: numBlocks disagreement (block index ${b.index} says ${b.numBlocks}, expected ${numBlocks})`);
    }
    if (b.blockNo !== i) {
      throw new Uf2ParseError(`family 0x${familyId.toString(16)}: expected blockNo ${i}, got ${b.blockNo} (block index ${b.index})`);
    }
  }
  if (sorted.length !== numBlocks) {
    throw new Uf2ParseError(`family 0x${familyId.toString(16)}: numBlocks says ${numBlocks} but ${sorted.length} blocks are present`);
  }
  const chunks = [];
  let prevEnd = -1;
  let rangeStart = Infinity;
  let rangeEnd = -Infinity;
  for (const b of sorted) {
    if (b.targetAddr < prevEnd) {
      throw new Uf2ParseError(`family 0x${familyId.toString(16)}: block ${b.blockNo} targetAddr 0x${b.targetAddr.toString(16)} overlaps or goes backwards past 0x${prevEnd.toString(16)}`);
    }
    chunks.push({ addr: b.targetAddr, data: b.payload });
    rangeStart = Math.min(rangeStart, b.targetAddr);
    rangeEnd = Math.max(rangeEnd, b.targetAddr + b.payloadSize);
    prevEnd = b.targetAddr + b.payloadSize;
  }
  return {
    familyId,
    chunks,
    rangeStart,
    rangeEnd,
    eraseStart: alignDown(rangeStart, FLASH_SECTOR_SIZE),
    eraseEnd: alignUp(rangeEnd, FLASH_SECTOR_SIZE)
  };
}
function coalesceWriteRuns(chunks, maxRunSize = PICOBOOT_MAX_WRITE_SIZE) {
  if (chunks.length === 0)
    return [];
  const runs = [];
  let runAddr = chunks[0].addr;
  let parts = [chunks[0].data];
  let runLen = chunks[0].data.length;
  let nextExpectedAddr = runAddr + runLen;
  const flush = () => {
    const combined = new Uint8Array(runLen);
    let offset = 0;
    for (const part of parts) {
      combined.set(part, offset);
      offset += part.length;
    }
    runs.push({ addr: runAddr, data: combined });
  };
  for (let i = 1;i < chunks.length; i++) {
    const chunk = chunks[i];
    const contiguous = chunk.addr === nextExpectedAddr;
    const fitsCap = runLen + chunk.data.length <= maxRunSize;
    if (contiguous && fitsCap) {
      parts.push(chunk.data);
      runLen += chunk.data.length;
      nextExpectedAddr = chunk.addr + chunk.data.length;
    } else {
      flush();
      runAddr = chunk.addr;
      parts = [chunk.data];
      runLen = chunk.data.length;
      nextExpectedAddr = runAddr + runLen;
    }
  }
  flush();
  return runs;
}
function planEraseSpans(eraseStart, eraseEnd, maxSpanSize = PICOBOOT_MAX_ERASE_SPAN) {
  const spans = [];
  for (let addr = eraseStart;addr < eraseEnd; addr += maxSpanSize) {
    spans.push({ addr, size: Math.min(maxSpanSize, eraseEnd - addr) });
  }
  return spans;
}
function parseUf2(bytes) {
  const blocks = parseUf2Blocks(bytes);
  return { blocks, familyGroups: groupByFamily(blocks) };
}

// site/flasher/picoboot.ts
var PICOBOOT_MAGIC = 1126158603;
var PICOBOOT_CMD = {
  EXCLUSIVE_ACCESS: 1,
  REBOOT: 2,
  FLASH_ERASE: 3,
  WRITE: 5,
  EXIT_XIP: 6,
  REBOOT2: 10
};
var REBOOT2_FLAG_REBOOT_TYPE_NORMAL = 2;
var PICOBOOT_PACKET_SIZE = 32;
var ARGS_OFFSET = 16;
var ARGS_SIZE = 16;
function buildPacket(cmdId, cmdSize, transferLen, token, fillArgs) {
  const buf = new Uint8Array(PICOBOOT_PACKET_SIZE);
  const view = new DataView(buf.buffer);
  view.setUint32(0, PICOBOOT_MAGIC >>> 0, true);
  view.setUint32(4, token >>> 0, true);
  buf[8] = cmdId & 255;
  buf[9] = cmdSize & 255;
  view.setUint16(10, 0, true);
  view.setUint32(12, transferLen >>> 0, true);
  const argsView = new DataView(buf.buffer, ARGS_OFFSET, ARGS_SIZE);
  fillArgs(argsView);
  return buf;
}
function buildExclusiveAccess(token, exclusive = 1) {
  return buildPacket(PICOBOOT_CMD.EXCLUSIVE_ACCESS, 1, 0, token, (v) => v.setUint8(0, exclusive));
}
function buildExitXip(token) {
  return buildPacket(PICOBOOT_CMD.EXIT_XIP, 0, 0, token, () => {});
}
function buildFlashErase(token, addr, size) {
  return buildPacket(PICOBOOT_CMD.FLASH_ERASE, 8, 0, token, (v) => {
    v.setUint32(0, addr >>> 0, true);
    v.setUint32(4, size >>> 0, true);
  });
}
function buildWrite(token, addr, size) {
  return buildPacket(PICOBOOT_CMD.WRITE, 8, size, token, (v) => {
    v.setUint32(0, addr >>> 0, true);
    v.setUint32(4, size >>> 0, true);
  });
}
function buildReboot2(token, flags, delayMs, p0 = 0, p1 = 0) {
  return buildPacket(PICOBOOT_CMD.REBOOT2, 16, 0, token, (v) => {
    v.setUint32(0, flags >>> 0, true);
    v.setUint32(4, delayMs >>> 0, true);
    v.setUint32(8, p0 >>> 0, true);
    v.setUint32(12, p1 >>> 0, true);
  });
}
function buildReboot(token, pc, sp, delayMs) {
  return buildPacket(PICOBOOT_CMD.REBOOT, 12, 0, token, (v) => {
    v.setUint32(0, pc >>> 0, true);
    v.setUint32(4, sp >>> 0, true);
    v.setUint32(8, delayMs >>> 0, true);
  });
}
function findPicobootInterface(device) {
  const config = device.configuration;
  if (!config)
    return null;
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== 255)
        continue;
      const epIn = alt.endpoints.find((e) => e.direction === "in" && e.type === "bulk");
      const epOut = alt.endpoints.find((e) => e.direction === "out" && e.type === "bulk");
      if (epIn && epOut) {
        return { interfaceNumber: iface.interfaceNumber, epIn: epIn.endpointNumber, epOut: epOut.endpointNumber };
      }
    }
  }
  return null;
}

class PicobootProtocolError extends Error {
}

class PicobootDevice {
  device;
  iface = null;
  token = 1;
  constructor(device) {
    this.device = device;
  }
  async open() {
    if (!this.device.opened)
      await this.device.open();
    if (!this.device.configuration)
      await this.device.selectConfiguration(1);
    const iface = findPicobootInterface(this.device);
    if (!iface)
      throw new PicobootProtocolError("no PICOBOOT (class 0xFF, bulk in/out) interface found on this device");
    this.iface = iface;
    await this.device.claimInterface(iface.interfaceNumber);
  }
  async close() {
    if (this.iface) {
      try {
        await this.device.releaseInterface(this.iface.interfaceNumber);
      } catch {}
    }
    try {
      await this.device.close();
    } catch {}
  }
  nextToken() {
    const t = this.token;
    this.token = this.token + 1 >>> 0;
    return t;
  }
  requireIface() {
    if (!this.iface)
      throw new PicobootProtocolError("PicobootDevice.open() was not called (or failed) before use");
    return this.iface;
  }
  async transferOutRecovering(data) {
    const iface = this.requireIface();
    const result = await this.device.transferOut(iface.epOut, data);
    if (result.status === "stall") {
      await this.device.clearHalt("out", iface.epOut);
      throw new PicobootProtocolError("bulk OUT transfer stalled (halt cleared); the command was not accepted");
    }
  }
  async readAck() {
    const iface = this.requireIface();
    const result = await this.device.transferIn(iface.epIn, 64);
    if (result.status === "stall") {
      await this.device.clearHalt("in", iface.epIn);
      throw new PicobootProtocolError("bulk IN transfer stalled while waiting for acknowledge (halt cleared)");
    }
  }
  async sendCommand(packet, dataOut) {
    await this.transferOutRecovering(packet);
    if (dataOut && dataOut.length > 0)
      await this.transferOutRecovering(dataOut);
    await this.readAck();
  }
  async exclusiveAccess(exclusive = 1) {
    await this.sendCommand(buildExclusiveAccess(this.nextToken(), exclusive));
  }
  async exitXip() {
    await this.sendCommand(buildExitXip(this.nextToken()));
  }
  async flashErase(addr, size) {
    await this.sendCommand(buildFlashErase(this.nextToken(), addr, size));
  }
  async write(addr, data) {
    await this.sendCommand(buildWrite(this.nextToken(), addr, data.length), data);
  }
  async reboot2(flags, delayMs) {
    await this.sendCommand(buildReboot2(this.nextToken(), flags, delayMs));
  }
  async reboot(pc, sp, delayMs) {
    await this.sendCommand(buildReboot(this.nextToken(), pc, sp, delayMs));
  }
}

// site/flasher/flash.ts
var RPI_VENDOR_ID = 11914;
var RP2350_BOOTSEL_PRODUCT_ID = 15;
var RP2040_BOOTSEL_PRODUCT_ID = 3;
var PUCK_RUNNING_PRODUCT_ID = 9;
var RESET_INTERFACE_CLASS = 255;
var RESET_INTERFACE_SUBCLASS = 0;
var RESET_INTERFACE_PROTOCOL = 1;
var RESET_REQUEST_BOOTSEL = 1;
var BOOTSEL_REENUMERATE_TIMEOUT_MS = 1e4;
var BOOTSEL_POLL_INTERVAL_MS = 250;
var REBOOT_DELAY_MS = 500;

class FlashError extends Error {
  code;
  constructor(message, code) {
    super(message);
    this.code = code;
  }
}
function isWebUsbSupported() {
  return typeof navigator !== "undefined" && !!navigator.usb;
}
function classifyDevice(device) {
  if (device.vendorId !== RPI_VENDOR_ID)
    return "unknown";
  if (device.productId === RP2350_BOOTSEL_PRODUCT_ID)
    return "bootsel-rp2350";
  if (device.productId === RP2040_BOOTSEL_PRODUCT_ID)
    return "bootsel-rp2040";
  if (device.productId === PUCK_RUNNING_PRODUCT_ID)
    return "running-puck";
  return "unknown";
}
function deviceFilters() {
  return [
    { vendorId: RPI_VENDOR_ID, productId: RP2350_BOOTSEL_PRODUCT_ID },
    { vendorId: RPI_VENDOR_ID, productId: RP2040_BOOTSEL_PRODUCT_ID },
    { vendorId: RPI_VENDOR_ID, productId: PUCK_RUNNING_PRODUCT_ID }
  ];
}
function buildBootselResetSetup(interfaceNumber) {
  return {
    requestType: "class",
    recipient: "interface",
    request: RESET_REQUEST_BOOTSEL,
    value: 0,
    index: interfaceNumber
  };
}
function findResetInterface(device) {
  const config = device.configuration;
  if (!config)
    return null;
  for (const iface of config.interfaces) {
    for (const alt of iface.alternates) {
      if (alt.interfaceClass !== RESET_INTERFACE_CLASS)
        continue;
      if (alt.interfaceSubclass !== RESET_INTERFACE_SUBCLASS)
        continue;
      if (alt.interfaceProtocol !== RESET_INTERFACE_PROTOCOL)
        continue;
      if (alt.endpoints.length !== 0)
        continue;
      return iface.interfaceNumber;
    }
  }
  return null;
}
function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
async function rebootRunningDeviceToBootsel(device) {
  if (!device.opened)
    await device.open();
  if (!device.configuration)
    await device.selectConfiguration(1);
  const interfaceNumber = findResetInterface(device);
  if (interfaceNumber === null) {
    try {
      await device.close();
    } catch {}
    throw new FlashError("This board is running firmware with no USB reset interface, so it can't be rebooted into BOOTSEL from here. " + "That's firmware built before 2026-08-19: use the BOOTSEL entry ritual below once, and every flash after that is a click.", "no-reset-interface");
  }
  await device.claimInterface(interfaceNumber);
  try {
    await device.controlTransferOut(buildBootselResetSetup(interfaceNumber));
  } catch {}
  try {
    await device.releaseInterface(interfaceNumber);
  } catch {}
  try {
    await device.close();
  } catch {}
}
async function waitForBootselDevice(timeoutMs = BOOTSEL_REENUMERATE_TIMEOUT_MS, pollMs = BOOTSEL_POLL_INTERVAL_MS) {
  if (!isWebUsbSupported())
    return null;
  const deadline = Date.now() + timeoutMs;
  for (;; ) {
    let devices = [];
    try {
      devices = await navigator.usb.getDevices();
    } catch {
      devices = [];
    }
    const found = devices.find((d) => classifyDevice(d) === "bootsel-rp2350");
    if (found)
      return found;
    if (Date.now() >= deadline)
      return null;
    await delay(pollMs);
  }
}
async function requestPicobootDevice() {
  if (!isWebUsbSupported()) {
    throw new FlashError("This browser doesn't support WebUSB. Use Chrome or Edge on desktop.", "unsupported-browser");
  }
  let device;
  try {
    device = await navigator.usb.requestDevice({ filters: deviceFilters() });
  } catch {
    throw new FlashError("No device was selected. Plug the board in over USB and pick it in the browser's device list; if it doesn't appear at all, see the BOOTSEL entry ritual below.", "no-device-selected");
  }
  if (classifyDevice(device) === "bootsel-rp2040") {
    throw new FlashError("That's an RP2040 BOOTSEL device. This .uf2 is built for RP2350 (a different chip family) and won't run on it.", "wrong-chip-family");
  }
  return device;
}
async function acquirePicobootDevice(onProgress) {
  const picked = await requestPicobootDevice();
  if (classifyDevice(picked) !== "running-puck")
    return picked;
  onProgress({ phase: "entering-bootsel", percent: 1, message: "Rebooting the device into BOOTSEL…" });
  await rebootRunningDeviceToBootsel(picked);
  onProgress({ phase: "entering-bootsel", percent: 2, message: "Waiting for the board to come back…" });
  const reenumerated = await waitForBootselDevice();
  if (reenumerated)
    return reenumerated;
  onProgress({ phase: "entering-bootsel", percent: 2, message: "Device rebooted to BOOTSEL, select it again…" });
  try {
    const again = await navigator.usb.requestDevice({
      filters: [{ vendorId: RPI_VENDOR_ID, productId: RP2350_BOOTSEL_PRODUCT_ID }]
    });
    if (classifyDevice(again) === "bootsel-rp2350")
      return again;
  } catch {}
  throw new FlashError("The board rebooted into BOOTSEL, but this page needs permission for it as a new USB device. Click Flash over USB again and pick the RP2 Boot device.", "bootsel-reselect-needed");
}
async function flashUf2(uf2Bytes, onProgress) {
  onProgress({ phase: "connecting", percent: 0, message: "Requesting device…" });
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
    const eraseSpans = planEraseSpans(plan.eraseStart, plan.eraseEnd);
    for (let i = 0;i < eraseSpans.length; i++) {
      const span = eraseSpans[i];
      await pb.flashErase(span.addr, span.size);
      const pct = 10 + Math.round((i + 1) / eraseSpans.length * 30);
      onProgress({ phase: "erasing", percent: pct, message: `Erasing ${i + 1}/${eraseSpans.length}` });
    }
    const writeRuns = coalesceWriteRuns(plan.chunks);
    for (let i = 0;i < writeRuns.length; i++) {
      const run = writeRuns[i];
      await pb.write(run.addr, run.data);
      const donePct = Math.round((i + 1) / writeRuns.length * 100);
      const pct = 40 + Math.round((i + 1) / writeRuns.length * 55);
      onProgress({ phase: "writing", percent: pct, message: `Writing ${donePct}%` });
    }
    onProgress({ phase: "rebooting", percent: 97, message: "Rebooting into the new firmware…" });
    try {
      await pb.reboot2(REBOOT2_FLAG_REBOOT_TYPE_NORMAL, REBOOT_DELAY_MS);
    } catch (err) {
      if (!(err instanceof PicobootProtocolError))
        throw err;
      await pb.reboot(0, 0, REBOOT_DELAY_MS);
    }
    onProgress({ phase: "done", percent: 100, message: "Done. The board is rebooting into the new firmware." });
  } catch (err) {
    if (err instanceof FlashError)
      throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new FlashError(`USB error while flashing: ${message}`, "usb-error");
  } finally {
    await pb.close();
  }
}

// site/flasher/flash-ui.ts
var PHASE_LABELS = {
  connecting: "connecting",
  "entering-bootsel": "rebooting into BOOTSEL",
  erasing: "erasing",
  writing: "writing",
  rebooting: "rebooting",
  done: "done"
};
var FLASH_DONE_HOLD_MS = 900;
var FLASH_DONE_FADE_MS = 400;
var FLASH_DONE_MESSAGE = "✓ Flashed. The board is restarting with the new firmware.";
function initSection(section) {
  const uf2Url = section.dataset.uf2;
  if (!uf2Url)
    return;
  const btn = section.querySelector(".flash-btn");
  const progressWrap = section.querySelector(".flash-progress");
  const progressBar = section.querySelector(".flash-progress-bar");
  const statusEl = section.querySelector(".flash-status");
  const doneEl = section.querySelector(".flash-done");
  const errorEl = section.querySelector(".flash-error");
  if (!btn || !progressWrap || !progressBar || !statusEl || !doneEl || !errorEl)
    return;
  let doneToken = 0;
  function showError(message) {
    doneToken++;
    errorEl.textContent = message;
    errorEl.hidden = false;
    doneEl.hidden = true;
    progressWrap.hidden = true;
    progressWrap.classList.remove("fade-out");
    progressBar.classList.remove("done");
  }
  function showDone() {
    const token = ++doneToken;
    progressBar.style.width = "100%";
    progressBar.classList.add("done");
    statusEl.textContent = "done: Done. The board is rebooting into the new firmware.";
    window.setTimeout(() => {
      if (token !== doneToken)
        return;
      progressWrap.classList.add("fade-out");
      window.setTimeout(() => {
        if (token !== doneToken)
          return;
        progressWrap.hidden = true;
        progressWrap.classList.remove("fade-out");
        progressBar.classList.remove("done");
        progressBar.style.width = "0%";
        doneEl.textContent = FLASH_DONE_MESSAGE;
        doneEl.hidden = false;
      }, FLASH_DONE_FADE_MS);
    }, FLASH_DONE_HOLD_MS);
  }
  function showProgress(p) {
    doneToken++;
    errorEl.hidden = true;
    doneEl.hidden = true;
    progressWrap.hidden = false;
    progressWrap.classList.remove("fade-out");
    progressBar.classList.remove("done");
    progressBar.style.width = `${p.percent}%`;
    statusEl.textContent = `${PHASE_LABELS[p.phase] ?? p.phase}: ${p.message}`;
    if (p.phase === "done")
      showDone();
  }
  async function run() {
    errorEl.hidden = true;
    if (!isWebUsbSupported()) {
      showError("WebUSB isn't available in this browser. Use Chrome or Edge on desktop.");
      return;
    }
    btn.disabled = true;
    try {
      showProgress({ phase: "connecting", percent: 0, message: "Fetching firmware image…" });
      const resp = await fetch(uf2Url);
      if (!resp.ok)
        throw new Error(`could not fetch ${uf2Url}: HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await flashUf2(bytes, showProgress);
    } catch (err) {
      if (err instanceof FlashError) {
        showError(err.message);
      } else {
        showError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      btn.disabled = false;
    }
  }
  btn.addEventListener("click", () => {
    run();
  });
}
function init() {
  const sections = document.querySelectorAll(".flash-section[data-uf2]");
  for (let i = 0;i < sections.length; i++) {
    initSection(sections[i]);
  }
}
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
