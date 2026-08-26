# Host frame-dump: attempted, not runnable in this environment

The donor's own `docs/testing-and-verification.md`
(`../../testing-and-verification.md`, vendored unmodified) documents a
"host simulator pattern": compile `gos_core/gfx.c`, `font.c` and game
sources on a host with `-DGOS_HOST_SIM`, drive a small `simN.c` harness
that scripts input and dumps 2x-upscaled PPM frames. That harness's own
source (`simN.c`, `fakeinc/`) is **not part of the vendored donor
repository** - the donor's own doc says plainly "Working examples live in
session scratchpads", meaning it was never committed to
`MikeWilson/esp32-gameos`. There is nothing to literally clone and run.

## What was actually attempted

`hostsim_main.c` in this directory is a from-scratch equivalent, written
for this task: the SAME real, unmodified vendored engine this port ships
(`core.c`, `gfx.c`, `input.c`, `font.c`, `gunship.c`, `slots.c`,
`golf.c`/`golf_render.c`/`golf_cards.c`, `apps.c`, `registry.c`,
`shell.c`), compiled for a HOST-NATIVE target instead of
`wasm32-freestanding`, reusing this port's own `gos_hal_shim.c` (already
proven correct by the wasm build) instead of the donor's undocumented
`GOS_HOST_SIM` branches, then driving `shell_init()`/`shell_frame()`
through the same synthetic-tick pattern `gameos_port.c` itself uses, and
dumping `gfx.c`'s own `dst`/`lut` framebuffer to a PPM by hand.

**It compiles cleanly** (`zig cc -c hostsim_main.c ... ` and
`gfx_band.c`, both exit 0, only the two pre-existing `SFX` macro-redefine
warnings this port's own wasm build already has). **Linking into an
executable does not work on this machine**: `zig cc` segfaults
deterministically at the link step, reproduced 8 times in a row across
several variants (with/without `gfx_band.o`, with `-fuse-ld=lld`, with an
explicit `-target aarch64-windows-gnu`, from a short output path to rule
out a path-length issue).

To isolate whether this was specific to this driver's own object files,
the same test was run against the most trivial possible C program:

```c
int main(void){return 0;}
```

`zig cc t.c -o t.exe` **also segfaults**, twice in a row. This is not the
documented "zig link segfault ~1 in 3" this repository's own `AGENTS.md`
states for the `wasm32-freestanding` target (which reliably succeeds
within a handful of retries, as it did for this port's own module build
during this task) - it is a distinct, apparently deterministic failure in
this machine's `zig cc` producing ANY native Windows executable at all.
The wasm32-freestanding path (this whole repository's actual, load-bearing
use of `zig`) is unaffected; only the host-native link path is broken
here.

## Conclusion

**Not runnable in this environment**, for a reason specific to this
machine's toolchain, not to the donor's own method or to this port's own
code: this port's real, vendored source compiles cleanly against a real
host target, but nothing on this machine can currently LINK a native
Windows executable with `zig cc`. `hostsim_main.c` is kept as real,
complete, ready-to-link reference material - on a machine (or a `zig`
version) where a native host link succeeds, `zig cc hostsim_main.c
../../../../../../packs/esp32-s3-touch-amoled-18/firmware/runtime/gfx_band.c
-I ../../../../ports/esp32-s3-touch-amoled-18 -I ../.. -I
../../../../../../packs/esp32-s3-touch-amoled-18/firmware/runtime -o
hostsim.exe && ./hostsim.exe out.ppm` should produce a frame directly
diffable against `../our-shell-boot.png` and `../../media/launcher.png`
with no wasm/canvas pipeline anywhere in the chain - the strongest form of
this comparison, not attempted here for a documented environment reason,
not skipped or faked.
