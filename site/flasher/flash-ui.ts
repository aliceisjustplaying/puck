// site/flasher/flash-ui.ts: the RP2350 run page's flash entrypoint. Bundled
// by site/build.ts into site/dist/flash/flash.js (same pattern the root
// build.ts uses for src/main.ts -> dist/main.js: one entrypoint, Bun.build,
// no CDN).
//
// Reads its target .uf2 URL from the section's own `data-uf2` attribute
// (set per-page by site/build.ts), fetches it same-origin, and drives
// flash.ts's flashUf2(). The DOM work - button, progress bar, status line,
// completed banner, error line - lives in flash-ui-common.ts, shared with the
// ESP32 entrypoint next door (esp32-ui.ts); this file is the RP2350 half of
// that split and nothing else.
//
// Failure states are read straight off FlashError.code (see flash.ts):
// "unsupported-browser" for no navigator.usb, "no-device-selected" for a
// cancelled/empty device picker, "wrong-chip-family" for an RP2040 board,
// "no-reset-interface" for a running board whose firmware predates the reset
// interface, "bootsel-reselect-needed" for a board that DID reboot into
// BOOTSEL but needs a fresh permission gesture, "usb-error" for everything
// else the transport can throw. Every one of them is already a full sentence
// telling the human what to do, so the UI renders the message and adds
// nothing.
import { flashUf2, isWebUsbSupported } from "./flash";
import { onSections, wireFlashSection } from "./flash-ui-common";

// The status line reads "<stage>: <detail>", and the raw phase names are
// identifiers, not English ("entering-bootsel"). This is the one place
// they become words.
const PHASE_LABELS: Record<string, string> = {
  connecting: "connecting",
  "entering-bootsel": "rebooting into BOOTSEL",
  erasing: "erasing",
  writing: "writing",
  rebooting: "rebooting",
  done: "done",
};

onSections(".flash-section[data-uf2]", (section) => {
  const uf2Url = section.dataset.uf2;
  if (!uf2Url) return;
  wireFlashSection(section, PHASE_LABELS, async (report) => {
    // Checked before anything else, and before any USB prompt, so an
    // unsupported browser gets an immediate, specific message rather than
    // a thrown exception or a picker that can never appear.
    if (!isWebUsbSupported()) {
      throw new Error("WebUSB isn't available in this browser. Use Chrome or Edge on desktop.");
    }
    report({ phase: "connecting", percent: 0, message: "Fetching firmware image…" });
    const resp = await fetch(uf2Url);
    if (!resp.ok) throw new Error(`could not fetch ${uf2Url}: HTTP ${resp.status}`);
    const bytes = new Uint8Array(await resp.arrayBuffer());
    await flashUf2(bytes, report);
  });
});
