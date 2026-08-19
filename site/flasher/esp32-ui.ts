// site/flasher/esp32-ui.ts: the ESP32-S3 run page's flash entrypoint. Bundled
// by site/build.ts into site/dist/flash/esp32-flash.js, the same way
// flash-ui.ts is bundled into flash.js: one entrypoint, Bun.build, no CDN.
// esptool-js and its deflate dependency are bundled in here, which is exactly
// why this is a second bundle rather than a branch inside the first one - an
// RP2350 run page has no reason to download an ESP32 serial protocol stack.
//
// Reads two attributes off the section, both set per-page by site/build.ts:
// `data-esp32-manifest` (the artifact index URL) and `data-esp32-image` (which
// image in it belongs to this combo). Everything else is esp32.ts's.
import { flashEsp32, isWebSerialSupported } from "./esp32";
import { onSections, wireFlashSection } from "./flash-ui-common";

// The status line reads "<stage>: <detail>". Same vocabulary as the RP2350
// section's (flash-ui.ts's PHASE_LABELS), minus the two phases that only
// exist over PICOBOOT: there is no separate erase step here (esptool-js
// erases as part of the write) and no BOOTSEL to enter.
const PHASE_LABELS: Record<string, string> = {
  connecting: "connecting",
  writing: "writing",
  rebooting: "rebooting",
  done: "done",
};

onSections(".flash-section[data-esp32-manifest]", (section) => {
  const manifestUrl = section.dataset.esp32Manifest;
  const imageId = section.dataset.esp32Image;
  if (!manifestUrl || !imageId) return;
  wireFlashSection(section, PHASE_LABELS, async (report) => {
    // Checked before anything else, and before any port prompt, so an
    // unsupported browser gets an immediate, specific message rather than a
    // thrown exception or a picker that can never appear.
    if (!isWebSerialSupported()) {
      throw new Error("Web Serial isn't available in this browser. Use Chrome or Edge on desktop.");
    }
    await flashEsp32(manifestUrl, imageId, report);
  });
});
