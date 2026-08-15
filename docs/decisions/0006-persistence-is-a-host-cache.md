# 0006: Persistence is a host cache, not a traced input

Date: 2026-08-15
Status: accepted

## Context

The live page currently creates a fresh module, calls `emu_init()`, reads the
device descriptor, validates the framebuffer, and swaps the new module into
the session. A replay creates another fresh instance and calls `emu_init()`
before applying only the recorded events. Those paths are visible in
`src/main.ts` (`bringUp`) and `src/replayCore.ts` (`replayFromBytes`). The
recorder's event-only contract is explicit in `src/recorder.ts`, and both the
in-page regression check in `src/regression.ts` and the differential harness in
`harness/diff.ts` depend on it.

A persistent drawing can be much larger than a useful trace. TinyDraw's world
is three panel widths by three panel heights
(`/Users/sarah/src/tries/2026-08-09-espdraw-puck/core/include/tinydraw/graphics/world_canvas.h`,
`WorldCanvas::kRequiredPixels`), and its Puck adapter stores that world as
16-bit pixels
(`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp`,
`WasmState::world`). That is about 3 MiB before any envelope. Putting such a
blob into every trace, baseline, or freeze would make debugging artifacts
large and would change the meaning of the existing event oracle.

Restoration also cannot be a host write performed after initialization.
TinyDraw constructs `RasterCore` inside `emu_init()`
(`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp`), and the
constructor clears the world and visible canvas before its first full push
(`/Users/sarah/src/tries/2026-08-09-espdraw-puck/core/src/raster_core.cpp`,
`RasterCore::RasterCore`). The guest must therefore own a load operation that
understands its snapshot and applies it after initialization.

## Decision

Persistence is an optional cache used only by the interactive page. It is not
an input event and it never becomes part of deterministic replay.

### Optional storage export group

A firmware that supports persistence exports all five functions below or none
of them:

```c
int      emu_storage_buffer(void);
uint32_t emu_storage_capacity(void);
uint32_t emu_storage_size(void);
uint32_t emu_storage_revision(void);
int      emu_storage_load(uint32_t length);
```

`emu_storage_buffer()` returns the byte offset of one guest-owned transfer
buffer. `emu_storage_capacity()` is its fixed maximum byte count.
`emu_storage_size()` is the current save payload length and must never exceed
that capacity. `emu_storage_revision()` is a wrapping sequence number that the
guest changes whenever the save payload changes. The host compares revision
values for inequality, so wrap does not turn a changed payload into an ordered
counter assumption.

For restore, the host copies at most `capacity` bytes into the transfer buffer
and calls `emu_storage_load(length)`. The guest validates and applies those
bytes. The return value is one of four explicit statuses:

| Value | Name | Meaning |
| --- | --- | --- |
| `0` | `EMU_STORAGE_ACCEPTED` | The snapshot was applied. |
| `1` | `EMU_STORAGE_EMPTY` | `length` was zero and the initialized empty state remains active. |
| `2` | `EMU_STORAGE_INCOMPATIBLE` | The bytes describe a layout the guest cannot load. |
| `3` | `EMU_STORAGE_CORRUPT` | The bytes fail the guest's integrity or structural checks. |

Any other status is an ABI failure. A partial group, an out-of-bounds buffer,
a size above capacity, or a descriptor/export mismatch also fails validation.
This follows the existing all-or-none optional apps and sound groups in
`scripts/audit.ts` and the canonical export lists in `src/abiSurface.ts`.

The call order is exact:

1. instantiate the module, including optional WASI reactor initialization as
   `src/wasm.ts` already does
2. call `emu_init()`
3. read and validate `emu_device()`, select the matching cache entry, and copy
   its bytes into `emu_storage_buffer()`
4. call `emu_storage_load(length)`, including `emu_storage_load(0)` when the
   matching store is empty
5. validate the framebuffer and build the descriptor-driven chrome
6. if storage was not accepted, optionally resume the previously selected app
   through `emu_app_switch()`
7. paint the framebuffer
8. deliver inputs and call the first `emu_tick()`

No host writes a blob behind the guest's back. In particular, restore is after
`emu_init()` and before the first tick. This extends the guarded setup in
`src/main.ts` and the fresh-instance setup in `src/replayCore.ts` without
moving guest initialization into the host. For a future firmware that exports
both optional groups, `emu_storage_load()` always runs before any
`emu_app_switch()` used to resume the prior app. An `EMU_STORAGE_ACCEPTED`
result skips app resume because the accepted guest snapshot, not stale
host-side app selection, owns the restored application state.

### Stable persistence identity

A firmware with the storage group declares this object in `emu_device()`:

```json
{
  "storage": {
    "id": "org.example.tinydraw.raster-world",
    "snapshotVersion": 1,
    "maxBytes": 2967552
  }
}
```

All three fields are required. `id` is a stable, firmware-owned identifier,
not the human-readable descriptor `name`. `snapshotVersion` identifies the
snapshot layout. `maxBytes` must equal `emu_storage_capacity()` and gives the
host a bound before it reads a blob from disk.

The cache key is the pair `(id, snapshotVersion)`. A cosmetic device-name
change does not accidentally select a different blob, while a different
firmware or an incompatible layout must use a different `id` or increment
`snapshotVersion`. A blob whose identity, snapshot version, or size bound does
not match is never copied into guest memory.

The auditor cross-checks both directions, as it already does for descriptor
`apps` and the app export pair in `scripts/audit.ts`: a descriptor storage
object without all five exports fails, and storage exports without the
object fail.

### Durability and reload behavior

After every successful `emu_tick()`, the interactive host polls
`emu_storage_revision()`. When it differs from the last observed value, the
host validates `size <= capacity` and immediately copies the guest payload
into host memory at that tick boundary. It writes the newest staged copy using
a **500 ms trailing-edge debounce**. More changes replace the pending copy and
restart the 500 ms timer.

On `pagehide`, the page makes one immediate, best-effort attempt to write the
latest staged copy rather than waiting for the debounce. Multi-megabyte
requests are not guaranteed to finish during page teardown, so this is not the
primary durability mechanism and the page must not claim that it is. The
regular debounced saves provide durability while the session is active.

The snapshot is application state, not a process image. TinyDraw's adapter
keeps `undo` separate from `world` in `WasmState`
(`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp`). Its
snapshot persists the drawing world, not `TileUndoHistory`: undo history is
explicitly not persisted across reload.

Reload behavior is split deliberately:

- A browser page reload has no surviving page memory, so the initial
  interactive bring-up GETs the matching cache from disk and restores it after
  `emu_init()`.
- A live module rebuild through the websocket `reloadModule` path restores
  from the newest in-memory staged host copy when its `(id, snapshotVersion)`
  still matches and the blob respects both size bounds. It does not perform a
  disk GET. This preserves changes captured at a tick boundary during the
  500 ms write debounce, which is the common firmware-edit loop this cache
  exists to serve.
- A changed identity or schema version, `INCOMPATIBLE`, or `CORRUPT` starts
  from the guest's initialized empty state and emits exactly one host console
  line explaining that storage was not restored. It does not retry with a
  differently keyed blob or keep a partially loaded module.

### Interactive server store

The bytes live on disk through a new `storageStore.ts` module shaped like
`baselineStore.ts`: filesystem persistence remains outside browser code and
can be tested without importing `server.ts`, whose module starts `Bun.serve()`.
`server.ts` adds local GET and PUT routes under `/api/storage`. The existing
server binding remains explicitly `127.0.0.1` (`server.ts`, `Bun.serve`). Both
storage routes adopt the origin-checking `guard()` used today by the baseline
and regression write routes (`postBaseline` and `postRegressionResult`), rather
than implying that every existing artifact route is already guarded.

Entries are stored under `storage/`, which is added to `.gitignore` beside
`baselines/`, `regressions/`, `freezes/`, and `traces/`. Each entry carries its
identity, schema version, max size, payload size, guest revision, and a server
generation. A PUT includes the generation returned by its GET or preceding
PUT. If that generation is stale, the server still accepts the new bytes,
because the policy is last-writer-wins, but reports the overwrite and the page
prints a console warning. Concurrent tabs are unsupported. The warning makes
that limitation visible instead of pretending the tabs have been merged.

### Isolation from deterministic paths

Every non-interactive instantiation uses an empty throwaway store. It may call
`emu_storage_load(0)` to exercise the guest's empty path, but it never reads or
writes `storage/`:

- page replay in `src/main.ts` and `src/replay.ts`
- shared headless replay in `src/replayCore.ts`
- baseline capture and checking in `src/regression.ts`, including its runner
  in `test/regression/run.ts`
- the emulator side of the differential harness in
  `harness/emulatorSide.ts`, reached from `harness/diff.ts`
- the harness's fake second instance in `harness/fixtures/loopbackLink.ts`
- ABI audit in `scripts/audit.ts`
- hostile browser tests in `test/hostile/run.ts`
- browser verification in `scripts/verify.ts`
- browser-driven GIF generation in `device/tools/demo.ts`
- the WASI fresh-instance test in `test/wasi/run.ts`

`bringUp` in `src/main.ts` therefore receives an explicit `interactive` or
`throwaway` storage mode. The initial load in `boot()` and every
`reloadModule()` call use interactive mode. `startReplay()` calls `bringUp`
directly in throwaway mode, which calls `emu_storage_load(0)` and performs no
storage GET or PUT. This distinction is mandatory because `bringUp` serves
both paths today. It cannot infer isolation merely from having a fresh wasm
instance.

The browser-driven hostile, verify, and demo tools open the page in explicit
throwaway mode. That mode disables both GET and PUT, rather than merely
starting from empty and then polluting the interactive store. Without it,
`bun run device:demo` could put a personal drawing into the generated GIF and
then overwrite that person's cache with demo state. The four-event pinned
consumer oracle remains a fresh-instance, event-only check for the same
reason.

`device/tools/screens.ts` and the TypeScript programs under
`device/wasm/tests/` instantiate raw WebAssembly directly rather than opening
the host page. They do not participate in the host cache or its HTTP routes
and are correctly outside this throwaway-page-mode change.

Traces remain only the `TraceEvent` sequence defined by `src/recorder.ts`.
`src/replayCore.ts` continues to reconstruct a run from a fresh instance and
those events. Regression baselines in `src/regression.ts`, harness traces read
by `harness/diff.ts`, audit, hostile tests, and verify never inherit a person's
saved drawing.

### Freeze bundles disclose presence, not contents

A freeze bundle adds a storage presence field with one of these shapes:

```json
{ "present": false }
```

or

```json
{
  "present": true,
  "id": "org.example.tinydraw.raster-world",
  "snapshotVersion": 1,
  "size": 2967552,
  "revision": 42
}
```

It never contains the blob. `src/freeze.ts` already treats a bundle as an
honest description of the captured session, including whether input history
was truncated and whether the engine was alive. Storage presence serves the
same purpose: an agent can see that the screenshot may depend on a persisted
starting state that the event list alone cannot reproduce. Omitting the
indicator would falsely present that event list as sufficient. Embedding the
blob would turn a lightweight diagnostic bundle into a multi-megabyte state
archive and blur the explicit boundary between host cache and trace.

Decision [0007](0007-battery-is-a-latched-input.md) is sequenced after this
decision and already bumps the freeze schema for its new input event. The
storage presence field rides that same schema bump. The implementation does
not create one intermediate freeze version for storage and another immediately
for battery.

## Rejected alternatives

- **Storage as a trace event:** rejected because it inflates every artifact,
  makes private application data part of routine captures, and invalidates
  fresh-boot event oracles.
- **Writing guest memory after `emu_init()`:** rejected because the host does
  not own the guest's layout or invariants, and real guest initialization can
  clear the destination.
- **Browser local storage:** rejected because multi-megabyte binary snapshots
  do not fit its useful shape and the existing local server already owns
  reload-surviving disk artifacts through `baselineStore.ts` and `server.ts`.
- **Persisting undo:** rejected because undo is transient editing machinery,
  not the durable drawing, and TinyDraw already stores it separately from the
  world.

## Implementation inventory

Implementing this decision touches the following repository files:

- `wasm/emu_abi.h`
- `docs/abi.md`
- `src/abiSurface.ts`
- `src/wasm.ts`
- `src/main.ts`
- `src/replayCore.ts`
- `src/freeze.ts`
- `src/recorder.ts`
- `src/replay.ts`
- `src/regression.ts`
- `src/storage.ts` (new host-side ABI and staging helper)
- `storageStore.ts` (new disk store)
- `server.ts`
- `.gitignore`
- `docs/agent-loop.md`
- `harness/emulatorSide.ts`
- `harness/fixtures/loopbackLink.ts`
- `scripts/audit.ts`
- `scripts/verify.ts`
- `device/tools/demo.ts`
- `test/regression/run.ts`
- `test/hostile/build.ts`
- `test/hostile/run.ts`
- new focused fixtures under `test/hostile/firmware/`
- `test/wasi/run.ts`

The consumer implements the five guest exports, descriptor identity, snapshot
validation, and world-only serialization in its own adapter. For TinyDraw that
work belongs in
`/Users/sarah/src/tries/2026-08-09-espdraw-puck/puck/puck_abi.cpp` and its build
and verification files, not in Puck's device-agnostic host.

## Consequences

Interactive reload can preserve real firmware-owned application state without
claiming that the host understands that state. Deterministic tools retain their
fresh-instance contract. A freeze can disclose that persisted state mattered
without carrying it. Firmware authors must version and validate their own
snapshot format, and concurrent browser tabs remain a visible, unsupported
last-writer-wins case.
