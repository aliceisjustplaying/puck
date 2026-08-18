# Device packs

A device pack is a self-contained folder for one hardware target. The folder, not this repository, is the unit of portability. Copying it elsewhere must leave it usable with a pinned puck checkout.

## Required contents

- `AGENTS.md`, the entry point for a person or LLM working on the device.
- `device.json`, the `emu_device()` descriptor plus a convention version and memory model. The implementation is the source of truth, and the file must match it.
- Vendored drivers, including local patches and documentation explaining every patch that must survive an upstream refresh.
- `gotchas.md`, the hardware traps earned through measurement and debugging.
- `gate/`, or an equivalent set of fast checks for device-specific invariants.
- A reference firmware implementing the app contract: `enter`, `tick`, and `leave` callbacks driven by a per-frame input struct.
- A build script that compiles the reference firmware and writes the pinned puck checkout's `wasm/dist/emu.wasm`, so `bun run dev` displays the device.

Nothing inside a pack imports emulator internals. The pack implements the public ABI and writes the agreed artifact. The dependency does not run in the other direction.

Packs may live under this repository's `packs/` directory or in an author's own repository. Local packs use a `{"name","path"}` entry in `registry.json`. External packs use a `{"name","url"}` entry.

The reference pack is [`packs/rp2350-touch-amoled-18`](../../packs/rp2350-touch-amoled-18/).
