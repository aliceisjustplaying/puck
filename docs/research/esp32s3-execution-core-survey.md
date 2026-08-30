# ESP32-S3 execution core survey

Date: 2026-08-30

## Outcome

The best first implementation spike is the interpreter from
[`levkropp/flexe`](https://github.com/levkropp/flexe), pinned to commit
`34ea9eb6eef921b59a55e6a435c7fc55c5727835`. It is small, MIT licensed,
written in C17, and already has an interpreter-only path that does not depend
on executable host memory. Its important limitation is that it implements the
original ESP32's Xtensa LX6 and memory map, not the ESP32-S3's LX7, PIE
instructions, or memory system.

Espressif QEMU, pinned to `esp-develop` commit
`febae182e132e4055529be423a818225ebddaa3a`, should be the execution oracle.
It has the most complete open ESP32-S3 instruction decoder, S3-specific TIE
and PIE semantics, dual-core machine model, interrupt matrix, flash, PSRAM,
and peripheral models. Its full runtime is a poor first browser dependency:
QEMU is GPL-2.0 as a whole, has no supported Emscripten build, and brings a
large operating-system and event-loop surface with it.

Neither candidate is cycle accurate. The timing model still has to be built.

## Requirements used for this survey

The execution backend needs to support:

- Real ESP32-S3 Xtensa code, including windowed registers, exceptions,
  interrupts, and the instructions emitted by the selected ESP-IDF toolchain.
- Two LX7 cores with deterministic interleaving and observable shared-memory
  traffic.
- Distinct internal SRAM, PSRAM, and flash access paths.
- Hooks at instruction fetches and data accesses so cache, bus, and memory
  latency can be charged independently of instruction semantics.
- A browser build using WebAssembly without runtime-generated native code.
- A license that can be carried by this repository, or an external oracle
  arrangement that keeps a stronger license outside the shipped browser
  backend.

## Candidate summary

| Candidate | Pin | License | CPU coverage | Dual core | Timing coverage | Browser outlook |
| --- | --- | --- | --- | --- | --- | --- |
| flexe | `34ea9eb6eef921b59a55e6a435c7fc55c5727835` | MIT | ESP32 LX6 interpreter, no S3 PIE | Two CPUs, sequential batches | One count per executed instruction, no cache timing | Best spike candidate |
| Espressif QEMU | `febae182e132e4055529be423a818225ebddaa3a` | GPL-2.0 overall | ESP32-S3 decoder, LX7 core configuration, S3 TIE and PIE | Full two-CPU machine model | Instruction count and functional devices, not cycle accurate | Possible through TCI, high port cost |

## Candidate 1: flexe

Repository: [`levkropp/flexe`](https://github.com/levkropp/flexe)

Audited commit: `34ea9eb6eef921b59a55e6a435c7fc55c5727835`

Commit date: 2026-08-01

License: MIT, copyright 2026 Lev Kropp. A derived implementation must retain
the copyright and permission notice.

### Useful implementation already present

- `src/xtensa.c` is a direct switch-based fetch, decode, and execute loop.
  The project describes it as roughly 3,500 lines for the LX6 ISA.
- The interpreter can run without the tracing JIT. Unsupported host
  architectures select `src/jit_stub.c`, which returns control to the normal
  interpreter.
- The public execution API runs bounded batches. This is a good fit for a
  browser worker and for a deterministic scheduler owned by Puck.
- The CPU state includes windowed registers, exceptions, interrupt handling,
  zero-overhead loops, `CCOUNT`, and timer comparisons.
- The repository includes two CPU instances. Core 1 is released by emulated
  startup state, then each core runs a sequential batch on the same host
  thread.
- Memory is represented by direct host buffers for SRAM, ROM, flash, RTC
  memory, and optional PSRAM. Peripheral accesses go through handlers.
- The project has instruction tests and reports booting several unmodified
  ESP-IDF applications on the original ESP32.

Primary references:

- [`README.md`](https://github.com/levkropp/flexe/blob/34ea9eb6eef921b59a55e6a435c7fc55c5727835/README.md)
- [`ARCHITECTURE.md`](https://github.com/levkropp/flexe/blob/34ea9eb6eef921b59a55e6a435c7fc55c5727835/ARCHITECTURE.md)
- [`src/xtensa.c`](https://github.com/levkropp/flexe/blob/34ea9eb6eef921b59a55e6a435c7fc55c5727835/src/xtensa.c)
- [`src/flexe_session.c`](https://github.com/levkropp/flexe/blob/34ea9eb6eef921b59a55e6a435c7fc55c5727835/src/flexe_session.c)
- [`LICENSE`](https://github.com/levkropp/flexe/blob/34ea9eb6eef921b59a55e6a435c7fc55c5727835/LICENSE)

### Gaps for ESP32-S3

- The implemented target is the original ESP32 LX6. The memory addresses,
  peripheral registers, boot process, and ROM hooks are for that chip.
- There is no ESP32-S3 LX7 profile.
- There is no implementation of the ESP32-S3 PIE vector and DSP instruction
  families, including the large `ee.*` instruction surface present in
  Espressif QEMU.
- Flash and PSRAM reads are direct buffer accesses. Cache behavior is ignored.
- Cache maintenance instructions are generally treated as no-ops.
- There is no shared-cache coherence or external-memory bus contention model.
- The value called a cycle is normally advanced once per interpreted
  instruction. This is useful for deterministic ordering, but it is not an
  LX7 cycle count.
- Dual-core execution uses batches and then synchronizes the cores' counters.
  This is not a model of instruction-level arbitration or simultaneous bus
  demand.
- The project is new and lightly adopted. Its test corpus is useful, but it is
  not an independent specification of ESP32-S3 behavior.

### WebAssembly implications

The CPU and memory core are structurally portable to WebAssembly. The browser
build should force the no-JIT path and export a small stateful API such as
create, reset, load image, run budget, inspect state, and inject input.

The repository does not currently ship a WebAssembly build. Work needed for a
browser spike includes:

- Remove or conditionalize `-march=native` and native link flags.
- Select `jit_stub.c` unconditionally for `wasm32`.
- Replace pthread mutexes with a single-thread no-op implementation for the
  first spike, or use WebAssembly threads only after the core works.
- Exclude the AOT loader, `dlopen`, native sockets, and direct file access.
- Exclude or replace OpenSSL-backed Wi-Fi, TLS, SHA, and loader helpers.
- Pass flash images and ELF metadata through byte arrays supplied by
  TypeScript.
- Replace host logging and callbacks with explicit imports or an event ring.

These changes are platform boundaries around a small interpreter. They do not
require rewriting the instruction engine.

## Candidate 2: Espressif QEMU

Repository: [`espressif/qemu`](https://github.com/espressif/qemu)

Audited branch and commit: `esp-develop` at
`febae182e132e4055529be423a818225ebddaa3a`

Commit date: 2026-02-23

License: QEMU as a whole is GPL-2.0. Individual files also carry compatible
licenses. The generated ESP32-S3 Xtensa configuration files carry a
permissive Tensilica notice, while the machine, cache, and execution
translation implementation is GPL-covered. Copying individual generated
configuration data into a differently licensed backend needs a deliberate
license review.

### Useful implementation already present

- `target/xtensa/core-esp32s3/xtensa-modules.inc.c` contains the generated
  configuration-specific decoder metadata for the ESP32-S3 Xtensa core.
- `target/xtensa/core-esp32s3/core-isa.h` records the configured architectural
  features and registers.
- `target/xtensa/translate.c` implements the general Xtensa translation path.
- `target/xtensa/translate_tie_esp32s3.c` implements the S3-specific TIE and
  PIE instruction semantics, including vector loads, stores, arithmetic, and
  FFT operations.
- `hw/xtensa/esp32s3.c` creates two CPUs, per-core address spaces, the
  interrupt matrix, flash, PSRAM, GDMA, timers, cryptographic devices, and
  other machine state.
- Espressif's support matrix marks dual-core CPU, flash MMU, QPI and OPI PSRAM,
  PSRAM MMU, GDMA, timers, and the principal cryptographic blocks as supported
  for ESP32-S3.
- QEMU can boot a merged ESP32-S3 flash image through the included ROM model.

Primary references:

- [ESP32-S3 QEMU guide](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/esp32s3/README.md)
- [Espressif QEMU support matrix](https://github.com/espressif/esp-toolchain-docs/blob/main/qemu/README.md)
- [`target/xtensa/core-esp32s3.c`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/target/xtensa/core-esp32s3.c)
- [`target/xtensa/translate_tie_esp32s3.c`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/target/xtensa/translate_tie_esp32s3.c)
- [`hw/xtensa/esp32s3.c`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/hw/xtensa/esp32s3.c)
- [`hw/misc/esp32s3_cache.c`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/hw/misc/esp32s3_cache.c)
- [`COPYING`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/COPYING)

### Timing and memory gaps

QEMU provides functional execution and functional device behavior. Its own
documentation states that TCG instruction counting must not be confused with
cycle-accurate emulation. It counts executed instructions and derives virtual
time from that count.

The ESP32-S3 cache device does not model cache lines, sets, ways, replacement,
hits, misses, fill latency, or arbitration:

- I-cache and D-cache regions are aliases of an IOMMU memory region.
- Mapping a flash MMU page copies the page from the block backend into a host
  RAM region.
- Mapped flash instruction and data reads then use that host RAM.
- PSRAM maps to the PSRAM device's backing memory region.
- Cache operation status is commonly reported as immediately complete.

This makes QEMU a strong correctness reference and a weak timing reference.
SRAM, PSRAM, flash, cache, and shared-bus timing still need an independent
model.

Reference: [QEMU TCG instruction counting](https://qemu.readthedocs.io/en/v9.1.3/devel/tcg-icount.html).

### WebAssembly implications

QEMU's TCG includes the Tiny Code Interpreter, or TCI. TCI translates guest
basic blocks into QEMU bytecode and interprets that bytecode. Its design goal
is support for hosts without a native TCG code generator, so it avoids the
need to emit executable WebAssembly memory at runtime.

TCI makes a WebAssembly port technically plausible, but the audited tree has
no Emscripten or WebAssembly host support. A full port would still need to
adapt QEMU's build system, threading, atomics, libffi usage, timers, block
backends, main loop, signals, file access, and browser-facing control API. TCI
is also documented as slow and less widely tested than native TCG backends.

Primary reference: [`tcg/tci/README`](https://github.com/espressif/qemu/blob/febae182e132e4055529be423a818225ebddaa3a/tcg/tci/README).

QEMU should therefore stay a native executable in the first phase. Puck can
drive it offline to produce instruction and state traces for comparison with
the WebAssembly backend.

## Other projects reviewed

### Espressif esp-emulator

[`espressif/esp-emulator`](https://github.com/espressif/esp-emulator) is an
Apache-2.0 Rust emulator with an existing browser WebAssembly build and a
multi-hart scheduler. It currently targets Espressif RISC-V chips: ESP32-C3,
ESP32-C6, ESP32-H2, ESP32-P4, and early ESP32-S31. It does not contain an
Xtensa LX7 execution core and cannot execute ESP32-S3 firmware.

Its WebAssembly API, browser packaging, deterministic scheduler, and use of
ROM stubs are useful design references. Its CPU core is not reusable for this
target.

### Wokwi and Cirkit Designer

Both products publicly demonstrate ESP32-S3 execution in a browser. No
reusable open-source LX7 execution core was found in their public repositories.
They can be used for behavioral comparisons through their supported products,
but they cannot be vendored as the Puck backend.

### Ghidra Xtensa processor descriptions

Ghidra and the older MIT-licensed `yath/ghidra-xtensa` project provide Xtensa
instruction descriptions for disassembly and analysis. They do not provide a
dual-core execution engine, ESP32-S3 machine, or timing model. The older
module also lists windowed registers, MAC16, and loop support as incomplete.
They are decoder references, not execution-core candidates.

## Recommendation

Build a bounded flexe spike and use Espressif QEMU as the oracle.

The spike should:

1. Pin flexe at `34ea9eb6eef921b59a55e6a435c7fc55c5727835` and preserve its MIT notice.
2. Compile only the interpreter, CPU state, and memory core to WebAssembly.
3. Run a small hand-authored Xtensa fixture in both native and WebAssembly
   builds and compare registers, memory, exceptions, and instruction counts.
4. Add an explicit ESP32-S3 target profile for reset state, address ranges,
   ROM mapping, internal SRAM aliases, flash windows, and PSRAM windows.
5. Execute a minimal ESP32-S3 ELF that avoids PIE instructions, then add
   missing general LX7 instructions from failing golden tests.
6. Use native Espressif QEMU at
   `febae182e132e4055529be423a818225ebddaa3a` to generate golden state traces.
7. Add PIE instructions only when the firmware or conformance corpus reaches
   them. QEMU's decoder tables identify the complete surface; its GPL-covered
   semantic implementation should remain in the external oracle unless the
   repository deliberately adopts compatible licensing.
8. Introduce timing as a separate interface from instruction semantics.
   Instruction fetches, loads, stores, atomics, cache operations, MMIO, and
   DMA should emit typed memory events. The timing model should consume those
   events and charge core stalls.
9. Keep both cores in one deterministic scheduler initially. Interleave at a
   configurable instruction or event boundary and record the ordering of
   shared-memory and bus requests.

The spike succeeds if the WebAssembly build reaches the same architectural
state as QEMU on a small ESP32-S3 corpus and exposes every instruction fetch
and data access needed by an external timing model. It does not need to boot a
full ESP-IDF image, emulate the display, or claim cycle accuracy.

## Timing architecture implied by the survey

No surveyed core supplies the needed timing. The execution backend should
therefore expose facts and let a separate model assign cost:

- Instruction class and architecturally completed instruction count.
- Fetch address, width, and backing region.
- Data address, width, direction, atomicity, and backing region.
- Cache-control operations and MMU mapping changes.
- Per-core ready time and stall reason.
- DMA and peripheral bus requests.

The first timing implementation can calibrate instruction classes and direct
SRAM, PSRAM, and flash costs from hardware measurements. Cache tags, line
fills, replacement, shared-bus arbitration, and flash or PSRAM transaction
shape can then be added without changing the decoder or architectural state
machine.

This separation is the main reason to start from flexe. Its direct interpreter
has obvious fetch and memory seams, while QEMU's TCG and memory-region stack
would require substantially more work to expose the same events in a browser
build.
