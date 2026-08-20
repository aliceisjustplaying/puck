# tinydraw on packs/web (SHOW PHASE)

Verdict: **degraded** (mode: adaptation), same source, same reasoning as
[`apps/tinydraw/ports/rp2350-touch-amoled-18/README.md`](../rp2350-touch-amoled-18/README.md).

`apps/tinydraw/ports/web/tinydraw.c` is a byte-for-byte copy of the rp2350 port,
the same pattern `apps/fluidbox/ports/web/fluid.c` already established for this
repo: the `--app` contract (`port_enter`/`port_tick`) and the `gfx.h`/`app.h`
surface it draws against are vendored byte-for-byte onto this pack (see
`packs/web/NOTICE.md`), including the 65536-byte app arena - `packs/web/device.json`
says this explicitly ("a browser has no SRAM budget; the rp2350 contract applies
unchanged"). A browser's own abundant memory does not relax the constraint that
produced this port's degradations (fixed-center 2x zoom, one-stroke undo, no
colour/toolbar): the ceiling is the shared CONTRACT's arena, not physical SRAM, so
the same reduced scope applies here on its own merits, not merely by copying the
file.

`bun run packs/web/wasm/build.ts --app apps/tinydraw/ports/web/tinydraw.c`
compiles (one zig retry, the documented intermittent linker crash, not a code
issue - AGENTS.md's own gotcha). Not separately traced or captured in this show
phase: the rp2350 demo trace already proves the shared source draws, zooms and
undoes correctly, and this file is textually identical.
