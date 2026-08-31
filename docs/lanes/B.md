# Lane B: measured mode and the backend adapter

Home: esp32sim fork, `lane-b/*` off `puck/base`. The design spike is
complete and dispositioned: decision 0014 is the normative contract, and
the spike's draft documents on `lane-b/design-spike` are historical
artifacts. This lane is now in the implementation phase.

Read first: decisions 0014 (the accepted contract, including its cut
list), 0013 (product identity), 0012 (trust model, observation
contract), 0008 (cost tiers); roadmap revision 4 lane B row; the timing
lab (`packs/esp32-s3-touch-amoled-18/timing/README.md`) as cost
evidence, noting 0014 rejects schema-1 `timing.json` for measured totals
and assigns schema 2 to this lane.

Hard constraints:
- Observation is defined at the CPU backend level. A `Bus`-trait wrapper
  alone is insufficient: the native JIT fast path bypasses it
  (`xtensa-lx7/src/block.rs:143,187`). Measured mode is interpreter-first;
  JIT participates only after a cross-mode conformance program (RAM,
  flash, MMIO, faults, self-modifying, cross-page) proves observation
  equivalence.
- Fast mode is never taxed: measured mode is a feature/flag, and upstream
  behavior with it off is bit-identical.
- Costs come from receipt-pinned manifests with decision-0008 tiers;
  unknown costs stay unknown and block totals; no invented cycles. The
  toolchain-sensitive first-line cache class stays blocked until lane
  0's disposition lands.
- Networking off; interpreter-only; single core (0014).
- Implement only what decision 0014 accepts: its cut list (hash-chain
  ledger, classifier fallback, binary identity formats, exhaustive
  quota constants, contractual wasm load protocol) is binding. Identity
  artifact formats belong to lanes A and E.

Implementation scope: the `backend-api` crate
(create/load/reset/run-to-deadline/inject/drain/inspect/capabilities/
close), a fake backend and the esp32sim backend passing the same
contract tests including the slice-invariance property test, the
measured interpreter scheduler per 0014, timing-profile schema 2 and its
importer, then measured-mode cost payload: per-block base costs, cache
and line-fill models, window-exception pair (35 cycles), loop-alignment
rule (+1 cycle at +3 mod 4), dependent load-use, MMIO classes with the
affine intercept preserved. Differential: the one-shot gate of 0014
(shared traces through the existing TypeScript timing machine and
measured mode once, compare ledgers, archive the receipt, retire the
TypeScript machine).

Out of scope: dual-core contention policy (lane C), wasm JIT (lane D),
board devices (lane A).

Exit: adapter contract tests green on both backends, slice-invariance
property test included; measured mode reproduces the flexe boot replay's
event accounting on shared traces; the one-shot differential receipt is
archived; determinism rule holds (same trace in, same cycle ledger out).
