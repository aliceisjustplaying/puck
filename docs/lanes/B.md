# Lane B: measured mode and the backend adapter

Home: esp32sim fork, `lane-b/*` off `puck/base`. Design spike first: a
throwaway branch whose deliverable is an interface spec, not merged code.

Read first: decisions 0012 (trust model, adapter contract, observation
contract), 0008 (cost tiers), 0011; roadmap lane B row and the design
spike paragraph; review F-031/032/033/034 dispositions; the timing lab
(`packs/esp32-s3-touch-amoled-18/timing/README.md` and `timing.json`) as
the only cost source.

Hard constraints:
- Observation is defined at the CPU backend level. A `Bus`-trait wrapper
  alone is insufficient: the native JIT fast path bypasses it
  (`xtensa-lx7/src/block.rs:143,187`). Measured mode is interpreter-first;
  JIT participates only after a cross-mode conformance program (RAM,
  flash, MMIO, faults, self-modifying, cross-page) proves observation
  equivalence.
- Fast mode is never taxed: measured mode is a feature/flag, and upstream
  behavior with it off is bit-identical.
- Costs come from `timing.json` with decision-0008 tiers; unknown costs
  stay unknown and block totals; no invented cycles.
- Networking off; run interpreter-only during the spike.

Scope after the spike: the Puck-owned adapter (create/load/reset/
run-to-deadline/inject/drain/inspect/capabilities/close per 0012), a fake
backend and the esp32sim backend passing the same contract tests, then
measured-mode cost payload: per-block base costs, cache and line-fill
models, window-exception pair (35 cycles), loop-alignment rule
(+1 cycle at +3 mod 4), dependent load-use, MMIO classes. Differential:
same trace into the TypeScript timing machine and measured mode, same
ledger out.

Out of scope: dual-core contention policy (lane C), wasm JIT (lane D),
board devices (lane A).

Exit: spike interface spec reviewed by maintainer; adapter contract
tests green on both backends; measured mode reproduces the flexe boot
replay's event accounting on shared traces; determinism rule holds (same
trace in, same cycle ledger out).
