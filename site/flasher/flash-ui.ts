// site/flasher/flash-ui.ts: DOM glue for the "Flash to the real device"
// section on a run page. Bundled by site/build.ts into
// site/dist/flash/flash.js (same pattern the root build.ts uses for
// src/main.ts -> dist/main.js: one entrypoint, Bun.build, no CDN).
//
// Reads its target .uf2 URL from the section's own `data-uf2` attribute
// (set per-page by site/build.ts), fetches it same-origin, and drives
// flash.ts's flashUf2() with a progress callback that paints the section's
// own progress bar and status line. Failure states are read straight off
// FlashError.code (see flash.ts): "unsupported-browser" for no
// navigator.usb, "no-device-selected" for a cancelled/empty device picker,
// "wrong-chip-family" for an RP2040 board, "no-reset-interface" for a
// running board whose firmware predates the reset interface,
// "bootsel-reselect-needed" for a board that DID reboot into BOOTSEL but
// needs a fresh permission gesture, "usb-error" for everything else the
// transport can throw. Every one of them is already a full sentence
// telling the human what to do, so this file renders the message and adds
// nothing.
import { FlashError, flashUf2, isWebUsbSupported, type FlashPhase, type FlashProgress } from "./flash";

// The status line reads "<stage>: <detail>", and the raw phase names are
// identifiers, not English ("entering-bootsel"). This is the one place
// they become words.
const PHASE_LABELS: Record<FlashPhase, string> = {
  connecting: "connecting",
  "entering-bootsel": "rebooting into BOOTSEL",
  erasing: "erasing",
  writing: "writing",
  rebooting: "rebooting",
  done: "done",
};

function initSection(section: HTMLElement): void {
  const uf2Url = section.dataset.uf2;
  if (!uf2Url) return;

  const btn = section.querySelector<HTMLButtonElement>(".flash-btn");
  const progressWrap = section.querySelector<HTMLElement>(".flash-progress");
  const progressBar = section.querySelector<HTMLElement>(".flash-progress-bar");
  const statusEl = section.querySelector<HTMLElement>(".flash-status");
  const errorEl = section.querySelector<HTMLElement>(".flash-error");
  if (!btn || !progressWrap || !progressBar || !statusEl || !errorEl) return;

  function showError(message: string): void {
    errorEl!.textContent = message;
    errorEl!.hidden = false;
    progressWrap!.hidden = true;
  }

  function showProgress(p: FlashProgress): void {
    errorEl!.hidden = true;
    progressWrap!.hidden = false;
    progressBar!.style.width = `${p.percent}%`;
    statusEl!.textContent = `${PHASE_LABELS[p.phase] ?? p.phase}: ${p.message}`;
  }

  async function run(): Promise<void> {
    errorEl!.hidden = true;
    // Checked before anything else, and before any USB prompt, so an
    // unsupported browser gets an immediate, specific message rather than
    // a thrown exception or a picker that can never appear.
    if (!isWebUsbSupported()) {
      showError("WebUSB isn't available in this browser. Use Chrome or Edge on desktop.");
      return;
    }
    btn!.disabled = true;
    try {
      showProgress({ phase: "connecting", percent: 0, message: "Fetching firmware image…" });
      const resp = await fetch(uf2Url!);
      if (!resp.ok) throw new Error(`could not fetch ${uf2Url}: HTTP ${resp.status}`);
      const bytes = new Uint8Array(await resp.arrayBuffer());
      await flashUf2(bytes, showProgress);
    } catch (err) {
      if (err instanceof FlashError) {
        showError(err.message);
      } else {
        showError(err instanceof Error ? err.message : String(err));
      }
    } finally {
      btn!.disabled = false;
    }
  }

  btn.addEventListener("click", () => {
    void run();
  });
}

function init(): void {
  const sections = document.querySelectorAll<HTMLElement>(".flash-section[data-uf2]");
  for (let i = 0; i < sections.length; i++) {
    initSection(sections[i]!);
  }
}

if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", init);
} else {
  init();
}
