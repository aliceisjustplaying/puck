# 0002: Two compilers, not one object code

Date: 2026-08-13
Status: accepted

## What this corrects

The project this repo was extracted from originally described its
emulator's guarantee as "not the same algorithm, the same object code."
That line was corrected, in that project's own decision record, on the
same day it was written, and the correction is worth carrying forward
verbatim rather than re-introducing the overstatement in a fresh repo:

> This line originally read "Not the same algorithm. The same object
> code." That was an overstatement and it is worth killing rather than
> softening, because the whole argument for this design rests on being
> precise about what is shared.
>
> The wasm module is the same C, compiled by a DIFFERENT compiler to a
> DIFFERENT target than the one that ships. Two builds of one source, not
> one binary in two places.

**Say this plainly, in this repo's own README and docs, rather than
letting a reader assume more**: your firmware's wasm build and your real
build are the same source, run through two different toolchains, targeting
two different instruction sets. What that buys is real - application
logic, layout, and redraw decisions cannot drift, because there is one
source feeding both builds. What it does NOT buy is compiler-level
identity: a bug that depends on code generation, integer-width handling,
float precision, or undefined-behaviour resolution differing between the
two compilers is out of reach here, and belongs on real hardware.

## Why this matters enough to have its own decision record

The correction was found by comparing this architecture against
[Speculos](https://github.com/LedgerHQ/speculos), Ledger's hardware wallet
emulator - the closest peer this design was checked against. Speculos
genuinely does run the shipped binary: it executes the real app ELF, built
by the SAME toolchain that ships to the secure element, under QEMU
user-mode emulation, and traps exactly one instruction (`svc` → `udf`) to
reimplement a narrow OS syscall surface. That is a stronger claim than this
project's, and it is available to Ledger because their app never touches
hardware directly - the OS syscall boundary is the only place an app
crosses into anything platform-specific.

This project's equivalent boundary (an app never touches hardware
directly, only a runtime's own screen/input/sensor interface - see
`docs/abi.md`) is real and is the reason this architecture works AT ALL.
But there is no equivalent of Speculos's single-instruction syscall trap
here: a firmware built for a real microcontroller runs bare metal, with no
OS underneath it to fake. So the wasm build has to be compiled fresh, by a
toolchain that targets `wasm32-freestanding` (this repo's example uses
`zig cc`; emscripten and wasi-sdk are the other realistic choices, see
`example/build.ts`'s header comment for why `zig cc` specifically), rather
than reusing whatever ships to the real chip. Two builds of one source is
the honest description of what that produces, and Speculos's stronger
guarantee is the reason this repo doesn't get to claim the same thing.

## Consequence

State the two-compilers boundary in the README's first section on
limitations, not buried in a decision record nobody reads before shipping
a firmware. A tool that overclaims what it guarantees costs a firmware
author real debugging time the first time a divergence turns out to be
compiler-level rather than logic-level; better to have set that
expectation from the first page.

See [`docs/harness.md`](../harness.md) for the differential test harness
this repo adds specifically to catch divergence behaviourally (at the
framebuffer, for a given input trace) without requiring compiler-level
object-code identity to trust the tool at all - and for what even that
harness cannot catch.
