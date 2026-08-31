# 0014: Measured scheduler and adapter contract, trimmed and accepted

Date: 2026-08-31
Status: accepted

## Context

Lane B's design spike delivered a draft decision and spike report
(`docs/browser-emulator-adapter-scheduler-decision-draft.md` and
`docs/browser-emulator-measured-mode-adapter-spike.md` on the fork's
`lane-b/design-spike` branch). The maintainer's adversarial review found
a sound scheduler core wrapped in premature protocol surface. This
record is the maintainer disposition: it accepts the core, cuts the
gold-plating, and answers the draft's approval checklist. The draft
remains a historical artifact; this record is normative.

## Accepted core

- One versioned Rust adapter in the fork is the only product entry to
  the machine. Workspace crate `backend-api` holds the interface and
  contract suite; measured scheduler and CPU observation live as modules
  in the existing `esp32s3` and `xtensa-lx7` crates; a `browser-backend`
  crate lands when the bridge is built, not before. Fast mode's run
  loop, block layouts, CCOUNT behavior, and JIT stay untouched.
- Version 1 measured capability: interpreter-only, single core (core 0),
  networking off. Capability absence is a typed refusal, never a silent
  fallback. Dual core waits for lane C's approved policy; JIT
  observation waits for the cross-mode conformance proof (decision
  0012).
- Same-cycle event order, stable: reset request; device completion and
  interrupt assertion; injected input in caller sequence order; CPU
  architectural boundary; output emission.
- Deferred completion-phase access is mandatory, not optional: an
  instruction's full cost and access shape resolve before it starts,
  with no guest-visible side effect; anything unresolved returns
  `TimingBlocked` carrying a decision-0008 tier candidate and changes no
  state; the data access executes exactly once at the completion cycle
  against post-event state. No value preview, no cached preflight. The
  draft's alternative path (preflight plus impact classifier) is out of
  the contract entirely.
- A pending instruction persists across `run_until` calls. Budgets
  (cycles, instructions, wall cancellation via a host-set flag polled at
  scheduler checkpoints, output, ledger) stop cleanly with the draft's
  stop precedence; no budget ever causes a partial architectural commit.
- Reset increments the epoch and zeroes virtual time; CCOUNT is a
  wrapping u32 projection of the epoch's virtual cycles; CCOMPARE
  matches are computed against every CCOUNT delta and assert at exact
  cycles.
- Device time: every active time-aware device answers with a deadline,
  with none, or with a typed unknown; unknown fails closed as
  `TimingBlocked`; a delivered deadline must advance device state or the
  run stops as a backend fault.
- Slice invariance: the same trace through any partitioning of
  `run_until` calls produces identical architectural state, events, and
  canonical ledger. Enforced by a property test comparing a partitioned
  run against a whole run, byte for byte. The draft's cumulative hash
  chain, delta hashes, and blocked-state hashes are cut; one SHA-256
  over the canonical ledger bytes is the comparison and receipt handle.
- The ledger carries decision-0008 tier claims with full receipt
  references (repository, commit, path, hash, firmware, sdkconfig,
  toolchain, board revision, adoption status). An unknown cost blocks
  any claim of a complete total. The importer rejects claims whose
  receipts do not match the manifest.
- Schema-1 `timing.json` is rejected for measured totals: it flattens
  the affine MMIO claim (the committed evidence is `3n - 8`; the profile
  scalar `3` loses the intercept). Timing-profile schema version 2 is
  owned by lane B. The toolchain-sensitive first-line cache costs stay
  blocked until lane 0 commits its pooling diagnosis and adoption
  disposition; subsequent-line and MMIO observations remain usable
  through accepted exact-toolchain receipts.
- Chip identity is a set of hash-pinned artifacts the adapter treats as
  opaque. Their formats are defined by lanes A and E when real captures
  exist, and are not part of this contract. The draft's efuse word
  layout, MAC decode formulas, 152-byte filter receipt, and
  reset-register address tables are cut from the contract; the concepts
  (raw capture retained as provenance, only a derived allowlisted subset
  ever applied, mismatch fails closed) survive as requirements for that
  future format.
- Boot: real ROM plus complete flash image is the product boot. The
  direct-application path stays as a separately advertised development
  capability; its output never satisfies a product, real-ROM, or
  correlation claim, and every receipt names the active boot mode.
- Quotas in version 1 are a small set of accident bounds (artifact
  count and total bytes, runtime memory, queue counts and bytes, inspect
  bytes, run budgets). Exact values are implementation constants, not
  contract. Byte-exact queue accounting and the exhaustive constant
  catalog are cut. Deep validator and quota hardening is lane H's,
  scoped by decision 0012 to public paths.
- The WebAssembly chunked-loading protocol is an implementation detail
  of the bridge, reviewed in code, not specified in this contract.
- Naming: the board is the Waveshare ESP32-S3-Touch-AMOLED-1.8 at the
  maintainer's revision. The touch controller is not named in any schema
  until lane A's capture identifies it.

## One-shot differential gate

Before measured mode's first correctness claim, lane B replays shared
traces through the existing TypeScript timing machine
(`packs/esp32-s3-touch-amoled-18/timing/`) and through measured mode,
compares ledgers, and archives the comparison as a receipt in puck. The
TypeScript machine is then retired as donor history. No new TypeScript
execution code is written for this gate.

## Draft approval checklist, answered

Scheduler ordering: accepted. Single-core boundary: accepted. Crate and
module homes: accepted, `browser-backend` deferred until the bridge
exists. Amendments to 0011 and 0012: accepted in substance via decision
0013 and amendment notes, not verbatim. Roadmap revision 4: published.
Numbered decision home: this record, in puck. Timing-profile schema
version 2 owner: lane B. Lane H validator review owner: lane H, scoped
by decision 0012.
