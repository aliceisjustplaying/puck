# 0004: C++ firmware uses narrow WASI reactors

Date: 2026-08-14
Status: accepted

## Context

The original example uses Zig's `wasm32-freestanding` C target. That keeps the
module and host interface small, but it does not include a hosted C or C++
standard library. Real firmware can depend on C++20 containers, algorithms,
allocation, and other libc++ facilities. Adding header paths to the Zig command
does not solve that problem: a matching libc++, libc++abi, libc, allocator, and
compiler runtime are required.

Puck's loader also matters. It directly instantiates a raw `.wasm` module for
live reload, replay, and the differential harness. Replacing that path with a
generated JavaScript runtime would make every non-browser caller adopt a
second loader contract.

## Decision

Keep freestanding C as the smallest example and additionally accept
`wasm32-wasip1` **reactor** modules for C++ firmware.

A reactor exports `_initialize`; Puck calls it once after instantiation and
after obtaining the module's exported memory, before any caller can invoke
`emu_init`. The firmware still exports the same `emu_*` interface with C
linkage.

The host implements only this WASI Preview 1 surface:

- `fd_write` for stdout and stderr diagnostics, bounded to 1,024 iovecs and
  1 MiB per call, returning `E2BIG` above those limits
- rejecting `fd_close` and `fd_seek` implementations
- `proc_exit`, surfaced as a host error

Puck does not provide WASI clocks, randomness, arguments, environment,
networking, or filesystem operations. A module requesting one fails during
instantiation with the missing import named in the error. This preserves the
existing rule that `emu_tick(nowMs)` is the only time source and declared ABI
calls are the only inputs.

`test/wasi/` is the executable contract. It builds a C++20 fixture with libc++
and dynamic allocation, audits its exact imports and exports, exercises stderr,
proves input remains latched until `emu_tick`, and verifies fresh reactor
instances do not share state.

## Why not generated Emscripten JavaScript

Emscripten is a maintained browser-first C++ toolchain, but its normal output
adds a generated JavaScript module factory. Puck intentionally shares one raw
WebAssembly loader among the browser, replay engine, and differential harness.
A WASI reactor preserves that architecture and lets the final import table stay
explicitly audited.

Emscripten standalone WebAssembly can also produce reactor-like output, but it
may retain Emscripten-specific or WASI imports. It can be used only if its final
module passes the same import allowlist; it does not get a broader host surface
by default.

## Consequences

- C++ firmware needs a matching Clang, wasi-libc, and libc++ runtime. On macOS,
  Homebrew supplies these as `llvm`, `wasi-libc`, and `wasi-runtimes`.
- Allocation and the C++ runtime live inside the module and may grow linear
  memory. Firmware projects must set and test their own memory budget.
- Exceptions and RTTI are firmware build choices. The reference fixture turns
  both off because it does not use them.
- The freestanding C path and its import surface remain unchanged.
- Puck still does not become a general WASI runtime. Determinism is more
  important than making arbitrary hosted programs load.
