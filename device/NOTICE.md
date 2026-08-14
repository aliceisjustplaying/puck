# Third-party code in `device/`

The repository's own licence is MIT (see [`../LICENSE`](../LICENSE)). It does
not cover the files listed here, which come from elsewhere and keep their own
terms. Everything below is redistributable; this file records what each thing
is and where the permission comes from, so nobody has to work it out again.

## `firmware/lib/` - Waveshare

The panel driver, the touch controller, the IMU, the QSPI PIO transport and the
`DEV_Config` hardware layer come from the Waveshare demo download for this
board. They are the reason the firmware talks to the hardware at all.

**Five of the six modules carry a licence in the file itself.** `AMOLED/`,
`Config/`, `QSPI_PIO/` and `Touch/` each open with Waveshare's standard header
block, which is the MIT permission grant verbatim ("Permission is hereby
granted, free of charge, to any person obtaining a copy ... to deal in the
Software without restriction, including without limitation the rights to use,
copy, modify, merge, publish, distribute, sublicense, and/or sell copies").
Those headers are left intact in every file, which is what the grant asks for
in return.

**`QMI8658/` carries no header.** It is the QST reference driver for the
QMI8658 IMU, shipped inside Waveshare's demo the way vendor reference drivers
usually are: no notice, no copyright line. Waveshare also publish the
byte-identical file, under an explicit Apache-2.0 licence, in their own
repository for the sibling board:

  https://github.com/waveshareteam/RP2350-Touch-AMOLED-1.75
  `examples/C/01_GUI/lib/QMI8658/QMI8658.c`

That file and `firmware/lib/QMI8658/QMI8658.c` here are identical apart from
line endings, so the redistribution permission for this copy is Waveshare's own
Apache-2.0 grant on that publication rather than anything inferred.

**These files are patched, and the patches matter.** See
`docs/decisions/0001-push-min-width.md` and `device/AGENTS.md`'s "Gotchas that
bite": `AMOLED_1in8.c`'s DMA loop sends one row fewer than the window it just
declared, and the panel init waits are wrong in both directions against the
SH8601 datasheet. Re-copying these files from a fresh Waveshare download
silently reverts all of it.

## `third_party/lucide/` - Lucide, ISC

Five SVG icons from [Lucide](https://lucide.dev). The full ISC licence is in
`third_party/lucide/LICENSE`, unmodified. They are design-time input, not
runtime assets: `tools/lucide-convert.ts` and `tools/gen-lucide-menu-icons.ts`
flatten them into the point arrays that `firmware/apps/menu.c` carries, so the
shipped binary contains derived geometry rather than the SVGs themselves.

## tldraw - not vendored, credited

The sketchpad's pen is tldraw's model, not tldraw's code: streamline the
incoming points, simulate pressure from stroke speed, thin by it, taper both
ends. `firmware/apps/sketch.c` implements that in C from the algorithm, and no
tldraw source is present in this repository. The private repository this
firmware came from also vendored tldraw's actual `freehand/` sources for a
design-time tool; that tool is not carried here, and neither is that code.

## Raspberry Pi Pico SDK - referenced, not copied

`firmware/CMakeLists.txt` imports the pico-sdk from `PICO_SDK_PATH` at build
time (`pico_sdk_import.cmake`, which is the SDK's own standard bootstrap
snippet). The SDK itself is not in this repository; you install it separately,
as the build instructions say. It is BSD-3-Clause.
