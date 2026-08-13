// Builds a jump-to-app strip from the device descriptor's own "apps" array
// (names only, per emu_abi.h). Only rendered, and emu_app_current/
// emu_app_switch only ever called, when the firmware actually declared
// apps: "A firmware without a concept of apps leaves these unimplemented
// and the emulator will not call them."

import type { EmuExports } from "./wasm";

export interface AppStripControl {
  refresh(): void;
}

// guardedCall: the same direct-ABI-call guard main.ts already uses for
// button presses and the shake sensor (see main.ts's guardedAbiCall header
// comment) -- a click here is a DOM event handler exactly like those, sits
// entirely outside the tick loop's own try/catch, and calls straight into
// the module (emu_app_switch), so a trap in someone's app-switch handler
// gets the same #engineDead treatment rather than silently doing nothing.
export function buildAppStrip(
  container: HTMLElement,
  apps: string[],
  emu: EmuExports,
  guardedCall: (cause: string, fn: (liveEmu: EmuExports) => void) => void
): AppStripControl | null {
  container.innerHTML = "";
  if (apps.length === 0 || typeof emu.emu_app_switch !== "function" || typeof emu.emu_app_current !== "function") {
    container.parentElement?.classList.add("hidden");
    return null;
  }
  container.parentElement?.classList.remove("hidden");

  const buttons: HTMLButtonElement[] = apps.map((name, i) => {
    const btn = document.createElement("button");
    btn.className = "btn sec sm app-strip-btn";
    btn.textContent = name;
    btn.addEventListener("click", () => {
      guardedCall(`app switch to ${i} ("${name}")`, (liveEmu) => liveEmu.emu_app_switch?.(i));
    });
    container.appendChild(btn);
    return btn;
  });

  // NOT routed through guardedCall: main.ts only ever calls refresh() from
  // two places, bringUp()'s own guarded try block and afterTick() (itself
  // inside stepOnce's try/catch) -- never directly from a DOM handler. A
  // trap here is already caught by one of those outer guards, so wrapping
  // it a second time would just be dead ceremony.
  function refresh(): void {
    const current = emu.emu_app_current?.() ?? -1;
    buttons.forEach((b, i) => b.classList.toggle("active", i === current));
  }
  refresh();
  return { refresh };
}
