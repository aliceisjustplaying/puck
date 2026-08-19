# 0004: WASI-lite, four deterministic shims, not WASI

Date: 2026-08-19
Status: accepted

## The question

The ABI a module implements here is `wasm/emu_abi.h`, and nothing in it
needs an operating system: `emu_tick(nowMs)` hands the guest its clock,
`env.js_log` hands it a console, and the framebuffer is a plain array in
its own linear memory. So the loader (`src/wasm.ts`) built exactly that
import object and nothing else, and a module importing anything from
`wasi_snapshot_preview1` failed to instantiate.

That turned out to refuse modules whose authors never asked for WASI. A
C++ front end links its own runtime startup; another language's standard
library assumes a hosted target; a build that reaches `-target
wasm32-wasi` for one flag ends up with `fd_write` in its import section
whether or not a single line of the program prints anything. The author's
only move was to fight their own toolchain, on a project whose whole
premise is "recompile your own source and see it run".

The question is not "should this emulator support WASI". It is: what is
the smallest set of host imports that lets those toolchains produce a
loadable module, without giving up the one property everything else here
is built on?

## What is non-negotiable

Deterministic replay. A trace replays to the same pixels in the page, in
`bun run verify-bundle`, in the differential harness and in CI, on any
machine, at any later date. Every proof this repository makes rests on
that: `docs/convention/app-bundle.md`'s "listing is a reproduction, not a
submission", the pixel-exact port diffs, the hardware-free regression
check, the frames committed inside app bundles.

A host function breaks determinism if its result depends on anything the
trace does not carry. That is the entire test applied below.

## The four, and why each one passes that test

- **`fd_write`** routes fd 1 and fd 2 to the same sink as `env.js_log`.
  Output only; it changes nothing the guest can observe, and the page
  already has one console pane rather than three.
- **`clock_time_get`** returns the last `nowMs` passed to `emu_tick`,
  converted to nanoseconds, for every clock id. The trace carries those
  timestamps already, which is what makes this reproducible; reading the
  host's wall clock instead would make the same trace produce different
  results on every run. Before the first tick it reads 0, because this
  host has exactly one clock and it has not started. Distinguishing
  MONOTONIC from REALTIME would mean inventing a second clock no trace
  records.
- **`random_get`** fills the buffer from a small PRNG (mulberry32) seeded
  from the trace's own optional `seed` field, defaulting to a fixed
  constant. Real entropy is the textbook determinism break; a seed
  carried by the trace makes randomness a recorded input like any other.
  The seed is an optional field precisely so every trace recorded before
  this existed replays bit-identically under the default.
- **`proc_exit`** traps, with a message naming the code. WASI says the
  call does not return, and the only honest way for a JavaScript host to
  honour "does not return" is to throw. The alternative (return, set a
  flag, keep going) would let a module run past its own exit, which is
  worse than stopping.

The shims are built **only when the module's own import section asks for
them**, checked between `WebAssembly.compile` and `WebAssembly.instantiate`.
A module that imports none of them is linked against exactly the import
object it always was, with no WASI namespace present at all. That is not
tidiness: a host that always offers a capability invites its use, and
these four are a compatibility ramp, not a platform.

## Why anything else is a hard error, named

Any other `wasi_snapshot_preview1` import fails the load with a message
listing every offending symbol at once. Two alternatives were rejected:

- **A stub returning zero or `ENOSYS`.** This converts "this host cannot
  do that" into wrong behaviour discovered much later, in a frame diff
  nobody can explain. The honesty rule this repository runs on (never
  describe the emulator as running the exact shipped binary, never let a
  README's claim stand in for a verified run) says the same thing here:
  fail where the capability is missing, not where the consequence shows.
- **Real WASI, through a full preview1 implementation.** A filesystem, an
  environment, real entropy, a real clock: every one of them is state the
  trace does not carry, so the first module to touch any of it stops
  being replayable, and every proof downstream of replay quietly becomes
  a claim. That is the whole ballgame, traded for convenience.

Naming every unsupported symbol at once, rather than the first, is so an
author fixes their build in one pass instead of rediscovering the next
one after each rebuild.

## What this costs

This does not make every WASI-linking module loadable, and it is not meant
to. A module that genuinely links a WASI libc imports whatever that libc
needs, which is toolchain-dependent and generally larger than four; those
modules still fail, with a message naming exactly which symbols to get rid
of. (Not measured here: the zig build this repository uses segfaults
outright on its own `wasm32-wasi` target on this machine, so the exact
list a given libc pulls in is left to the author's own build to report,
which the error message now does for them.) The line is not "how many
symbols" but "which state": a file offset or an environment has no
deterministic answer, so admitting the symbol would mean admitting the
state behind it. An author in that position should be building against
`wasm32-freestanding` (see `docs/abi.md`'s "Building your firmware to
wasm"). What this ramp is for is the module that imports a handful of
these symbols without ever calling them.

## How this is proven

`bun run test:wasi` (`test/wasi/`) builds two fixture firmwares that
declare their wasi imports explicitly with clang's
`import_module`/`import_name` attributes, so exactly which symbols appear
is visible in the source rather than being whatever a libc happened to
drag in. It then drives the SAME replay path the page and the harness use
(`src/replayCore.ts`) and checks: a supported-subset module replays; the
`fd_write` line reaches the log; the clock follows `emu_tick` (and reads 0
before the first tick); the same seed reproduces byte-identical frames;
a different seed produces different ones and reproduces itself; an
unsupported import is refused by name; `proc_exit` halts with its code.

Red before green, verified rather than assumed: with `src/wasm.ts` reverted
to its pre-change state, check 1 fails with `import
wasi_snapshot_preview1:fd_write must be an object`.

## Consequences

- `Trace` (`src/recorder.ts`, mirrored in `harness/types.ts`) gains an
  optional `seed`. No `schemaVersion` bump: absent means the default, so
  every existing trace replays identically.
- `replayFromBytes`, `replayEmulator`, and the harness entry points that
  hold a whole `Trace` pass its seed through. A caller that forgets would
  silently replay a randomness-using module under the default seed, which
  is why the seed travels with the trace rather than as a CLI flag.
- `instantiate()` compiles first and inspects imports before linking. The
  error surface for a missing `env` import is unchanged.
- For a module that imports the clock, `emu_tick` is returned wrapped (in
  a copy of the exports object, which is frozen) so the host knows what
  time the guest was last told it is. Modules that import no WASI get the
  instance's own exports, untouched.
