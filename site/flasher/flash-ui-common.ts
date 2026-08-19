// site/flasher/flash-ui-common.ts: the DOM half of a "Flash to the real
// device" section, with no idea which board it is flashing.
//
// Extracted from flash-ui.ts when the ESP32-S3 pack grew a browser flashing
// path of its own (site/flasher/esp32.ts). The two transports have nothing in
// common below this file - WebUSB and PICOBOOT on one side, Web Serial and
// esptool-js on the other - but the section on the page is the same section:
// same button, same progress bar, same status line, same completed banner,
// same "the error message IS the instruction" rule. Duplicating that would
// have meant two done-phase animations drifting apart, so instead the
// board-specific entrypoints (flash-ui.ts, esp32-ui.ts) each hand this file a
// function that does the flashing and a table naming their own phases.
//
// The RP2350 path's behaviour through here is unchanged from when this code
// lived in flash-ui.ts: same order of DOM writes, same timings, same
// messages.

export interface UiProgress {
  /** A transport-specific phase name, looked up in the labels table. */
  phase: string;
  /** 0-100. */
  percent: number;
  message: string;
}

export type UiReport = (progress: UiProgress) => void;

/** Does the flashing. Whatever it throws is rendered as the section's error message, verbatim. */
export type UiRunner = (report: UiReport) => Promise<void>;

// The done phase gets a distinct, unmissable beat rather than just another
// muted log line: the bar turns success-green and holds for
// FLASH_DONE_HOLD_MS so a slow read catches it, then the whole progress block
// fades over FLASH_DONE_FADE_MS and is replaced by .flash-done - a
// completed-state banner, styled (site/styles.css) as unambiguously "it
// worked", not a status string. A real board takes a beat to actually restart
// after this fires, so the wording says "restarting", not "rebooted" (still in
// progress, not a promise the board is already back up).
const FLASH_DONE_HOLD_MS = 900;
const FLASH_DONE_FADE_MS = 400;
const FLASH_DONE_MESSAGE = "✓ Flashed. The board is restarting with the new firmware.";

/**
 * Wire one .flash-section: its button runs `run`, and every progress report
 * paints the bar, the status line and (on the "done" phase) the completed
 * banner. `phaseLabels` turns raw phase identifiers ("entering-bootsel") into
 * the words the status line shows; a phase with no entry falls back to its own
 * name.
 */
export function wireFlashSection(section: HTMLElement, phaseLabels: Record<string, string>, run: UiRunner): void {
  const btn = section.querySelector<HTMLButtonElement>(".flash-btn");
  const progressWrap = section.querySelector<HTMLElement>(".flash-progress");
  const progressBar = section.querySelector<HTMLElement>(".flash-progress-bar");
  const statusEl = section.querySelector<HTMLElement>(".flash-status");
  const doneEl = section.querySelector<HTMLElement>(".flash-done");
  const errorEl = section.querySelector<HTMLElement>(".flash-error");
  if (!btn || !progressWrap || !progressBar || !statusEl || !doneEl || !errorEl) return;

  // Bumped on every showProgress/showError call so a done-phase fade
  // sequence in flight from a PREVIOUS run (setTimeout chain below) can
  // tell it has been superseded and quietly no-op, instead of clobbering a
  // fresh run's progress bar or error message a moment later. btn.disabled
  // already keeps two runs from overlapping while one is in flight, but the
  // fade sequence deliberately outlives runOnce()'s own try/finally (it is
  // still ticking after `finally` re-enables the button), so a fast second
  // click right after a flash completes is the one case that needs this.
  let doneToken = 0;

  function showError(message: string): void {
    doneToken++;
    errorEl!.textContent = message;
    errorEl!.hidden = false;
    doneEl!.hidden = true;
    progressWrap!.hidden = true;
    progressWrap!.classList.remove("fade-out");
    progressBar!.classList.remove("done");
  }

  function showDone(): void {
    const token = ++doneToken;
    progressBar!.style.width = "100%";
    progressBar!.classList.add("done");
    window.setTimeout(() => {
      if (token !== doneToken) return; // superseded by a later run
      progressWrap!.classList.add("fade-out");
      window.setTimeout(() => {
        if (token !== doneToken) return;
        progressWrap!.hidden = true;
        progressWrap!.classList.remove("fade-out");
        progressBar!.classList.remove("done");
        progressBar!.style.width = "0%";
        doneEl!.textContent = FLASH_DONE_MESSAGE;
        doneEl!.hidden = false;
      }, FLASH_DONE_FADE_MS);
    }, FLASH_DONE_HOLD_MS);
  }

  function showProgress(p: UiProgress): void {
    doneToken++; // any done-phase fade sequence from an earlier run is now stale
    errorEl!.hidden = true;
    doneEl!.hidden = true;
    progressWrap!.hidden = false;
    progressWrap!.classList.remove("fade-out");
    progressBar!.classList.remove("done");
    progressBar!.style.width = `${p.percent}%`;
    statusEl!.textContent = `${phaseLabels[p.phase] ?? p.phase}: ${p.message}`;
    if (p.phase === "done") showDone();
  }

  async function runOnce(): Promise<void> {
    errorEl!.hidden = true;
    btn!.disabled = true;
    try {
      await run(showProgress);
    } catch (err) {
      // Every error this reaches is already a full sentence telling the
      // human what to do (see flash.ts's FlashError and esp32.ts's
      // Esp32FlashError); this renders it and adds nothing.
      showError(err instanceof Error ? err.message : String(err));
    } finally {
      btn!.disabled = false;
    }
  }

  btn.addEventListener("click", () => {
    void runOnce();
  });
}

/** Run `init` over every element matching `selector`, once the document has one. */
export function onSections(selector: string, init: (section: HTMLElement) => void): void {
  function go(): void {
    const sections = document.querySelectorAll<HTMLElement>(selector);
    for (let i = 0; i < sections.length; i++) init(sections[i]!);
  }
  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", go);
  } else {
    go();
  }
}
