# Lane D: the wasm JIT backend

Home: esp32sim fork, upstream-shaped: branch from `main`, built as a
contribution upstream's own roadmap asks for (its item 4 ends with "the
wasm backend for the browser build"). Coordinate scope with the upstream
author once contact is established.

Read first: decision 0010 (the real-time requirement and the measured
basis); roadmap lane D row;
[`../../experiments/esp32s3-browser-speed/README.md`](../../experiments/esp32s3-browser-speed/README.md)
(the yardstick: 109 MIPS interpreter in V8, about 4,600 emulated-MIPS
ceiling, negligible block-compile cost); upstream `docs/speed-plan.md`
and the existing AArch64 JIT in `xtensa-lx7/src/jit/`.

Scope: runtime wasm codegen for guest basic blocks in the browser build,
preserving upstream's invariant that `--no-jit` output is bit-identical.
Design for later measured-mode participation (inlined accounting seams),
but correctness and speed first.

Constraints: interpreter remains mandatory everywhere (decision 0012);
re-measure against the browser-speed probes as guards accrue; the
checkpoint from decision 0010 applies (a first measured version under
about 500 emulated MIPS stops the lane for profiling before features);
performance gates run on the maintainer's M1-class machine, cloud numbers
are directional.

Exit: browser real time on the hot-path workload that currently runs at
about 70 Minsn/s interpreted; bit-identity with the interpreter across
the conformance corpus; numbers recorded with receipts.
