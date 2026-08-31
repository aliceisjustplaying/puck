# Adversarial Architecture & Code Review
## Puck ESP32-S3 and Proposed ESP32Sim Foundation

**Review snapshot:** 2026-08-31  
**Supplied archive:** `puck-esp32s3-export-2026-08-31-r2.zip`  
**Archive SHA-256:** `32dbbd6890be1787bcbe22fbb7d0f57003ec4d69d4013fbc6adad67de0c05db1`  
**Detected Puck root:** `puck-esp32s3-export-2026-08-31/puck`  
**Detected ESP32Sim root:** `puck-esp32s3-export-2026-08-31/esp32sim`

## Executive decision

**Proceed with the project, but pause deep ESP32Sim implementation until a short foundation gate is complete.** The direction is strong: the repository demonstrates unusually good evidence habits, meaningful board calibration, content hashing, clear separation of concerns, and an honest roadmap. The highest risks are not a reason to abandon the work; they are concentrated, fixable boundary and governance gaps that should be addressed before more code multiplies them.

The immediate decision gates are: (1) explicit ESP32Sim licensing and asset provenance; (2) one hardened guest-host ABI shared by every execution mode; (3) required CI that runs the claimed proof matrix; (4) a Puck-owned ESP32Sim adapter that accounts for JIT fast-memory bypass; and (5) a V2 CO5300/CST820-first board plan. After those gates, the proposed architecture is credible and worth continuing.

**Finding distribution:** 6 P0 blockers, 26 P1 high-priority findings, 40 P2 medium-priority findings, and 8 P3 improvements.

### Current-state scorecard

| Area | Assessment | Review note |
|---|---|---|
| Direction and product thesis | **Strong** | The project is solving a real development bottleneck with a thoughtful full-system approach. |
| Evidence culture | **Strong** | Hashes, fixtures, calibration, hardware receipts, and differential thinking are unusually good. |
| Architecture clarity | **Promising** | Layering is sound, but the guest-host and ESP32Sim adapter contracts are not yet enforced. |
| Security boundary | **Needs first-milestone work** | Live-path hardening exists, while headless/WASI/resource/network boundaries remain incomplete. |
| Automated proof | **Needs expansion** | Useful tests exist, but the required CI surface is much narrower than the claimed proof surface. |
| ESP32Sim adoption readiness | **Conditional / not yet** | Technical fit is promising; licensing and integration semantics are blockers. |
| Board roadmap | **Feasible after reorder** | V2-first reduces uncertainty and makes hardware evidence actionable. |
| Release readiness | **Not yet** | This is a strong research/development snapshot, not a hardened release baseline. |

### First five decisions

1. Resolve and record the license/redistribution basis for ESP32Sim and all bundled binary assets.
1. Make the shared host validator and quotas the first code milestone, including headless/replay/WASI paths.
1. Expand required CI before feature work so every subsequent agent change is evaluated by the same proof contract.
1. Build an interpreter-first Puck adapter spike; prove timing/observation semantics before importing board peripherals.
1. Target the V2 CO5300/CST820 board first and defer SH8601/FT3168 implementation until board-specific evidence exists.

## Scope, method, and limits

This review covered the complete supplied archive, project and upstream source trees, roadmaps/architecture notes, workflow definitions, package and Cargo metadata, generated fixtures, guest-host/WebAssembly boundaries, headless and browser paths, board/calibration material, and the proposed ESP32Sim adoption seam. The review used source inspection, targeted adversarial pattern analysis, archive/path and provenance checks, and the project’s available build/test commands in an isolated temporary environment. The companion test log preserves command outcomes and output.

The review did **not** have physical access to either board revision, so hardware statements distinguish supplied direct evidence from inherited or proposed support. It is also a snapshot review: public ESP32Sim was checked at its 2026-08-30 head, while the authoritative implementation evidence is the source bundled in the supplied archive.

## What is already strong

### Evidence-first engineering

Exact hashes, built fixtures, calibration artifacts, regression outputs, and real-silicon receipts make the project falsifiable rather than aspirational.

### Good architectural instincts

The project separates artifact/registry concerns, host execution, board behavior, and upstream emulator work rather than starting with a monolith.

### Honest roadmap language

Unknowns and planned evidence are visible. That candor is a major asset and should remain a release requirement.

### Small dependency surface

Both the TypeScript/WebAssembly host and Rust emulator avoid a sprawling runtime dependency graph, reducing supply-chain complexity.

### Useful live hardening

The live canvas path already validates framebuffer/push outputs, demonstrating awareness that guest memory is untrusted.

### Strong regression material

TinyDraw calibration, display/audio fixtures, and replay concepts can become a high-quality conformance suite once provenance and semantic assertions are enforced.

### Board work grounded in reality

The V2 controller material and banded DMA design are practical and evidence-backed rather than purely conceptual.

### ESP32Sim technical ambition with receipts

Upstream boots unmodified firmware, uses real ROMs, compares behavior with physical silicon, preserves an interpreter oracle, and checks bit-identical outputs during performance work.

### Pinned upstream before integration

Reviewing an exact snapshot before agents start the graft is precisely the right time to uncover license, API, timing, and security assumptions.

### Agent-friendly documentation

Architecture and roadmap material provide a promising basis for ADRs, ownership, and acceptance-driven parallel work.

## Architecture model used for this review

The system should be treated as five trust-separated layers:
- **Pack and provenance layer:** manifests, registry/index, hashes, firmware/modules, fixtures, board definitions, and licenses.
- **Guest execution layer:** WebAssembly or ESP32 CPU execution, guest memory, WASI-lite imports, cycle scheduling, interrupts, and quotas.
- **Validated event layer:** typed framebuffer bands, serial/log events, audio, touch/GPIO, diagnostics, and result manifests.
- **Environment adapters:** browser Worker/canvas/audio/storage, headless runner/filesystem, native UI/WebSocket, deterministic transcripts, and optional live networking.
- **Trusted adjudication layer:** regression verifier, semantic assertions, artifact commit, CI status, release provenance, and hardware-oracle comparison.

The key architectural rule is that raw guest values may cross only from the guest execution layer into one shared validator. Every later layer should operate on validated, bounded domain objects. ESP32Sim should sit behind a Puck-owned backend adapter and must not become a shortcut around that rule.

## Verification snapshot

Puck source metrics: 980 text files, approximately 840,358 lines. ESP32Sim metrics: 406 text files, approximately 79,421 lines. These counts exclude common build/cache directories and large binaries.

| Check | Status | Duration | Notes |
|---|---:|---:|---|
| `puck-script:typecheck` | **fail** | 0.26s | error TS5023: Unknown compiler option '--runInBand'. |
| `puck-script:test:hostile` | **fail** | 0.11s | sh: 1: bun: not found |
| `puck-script:test:regression` | **fail** | 0.11s | sh: 1: bun: not found |
| `puck-script:build` | **fail** | 0.09s | sh: 1: bun: not found |

A failed command can reflect a real defect, a missing local dependency/tool, or a deliberately absent external corpus. The detailed log keeps those cases separate; the architectural conclusion is that required CI must make the intended environment and nonzero test execution explicit.

## Priority findings

| ID | Priority | Finding | Required decision |
|---|---:|---|---|
| F-001 | **P0** | Resolve ESP32Sim’s license before treating it as a foundation | Obtain an explicit license from the author or a signed contribution/license agreement; add a root LICENSE, NOTICE, source provenance record, and a third-party inventory before any product branch imports or modifies the code. |
| F-002 | **P1** | Turn the pinned snapshot into a reproducible upstream provenance record | Create `third_party/esp32sim/PROVENANCE.md` with upstream URL, exact commit, retrieval date, archive hash, local patch series, license, and approved update procedure. |
| F-003 | **P1** | Inventory redistribution rights for ROMs, firmware blobs, fonts, audio, and calibration fixtures | Add an asset manifest with source, author, license/permission, whether redistribution is allowed, whether the asset may be public, and the build recipe. Keep restricted fixtures in a separately controlled store. |
| F-005 | **P1** | Pin CI actions and downloaded toolchain artifacts by immutable digest | Pin every GitHub Action to a full commit SHA, use minimal permissions, verify downloaded ROM/toolchain/archive SHA-256 values, and record approved update automation. |
| F-011 | **P0** | Use one mandatory guest-output validator in live, headless, replay, and verification paths | Move pointer/range/dimension/stride/count validation into a pure shared boundary module. All consumers must receive validated value objects, never raw guest pointers. |
| F-012 | **P0** | Harden every WASI-lite import as an untrusted ABI | Implement checked `u64` arithmetic, memory-range validation after every memory refresh, caps on iovec count and total bytes, bounded UTF-8 decoding, deterministic clock/random behavior, and explicit errno returns. |
| F-013 | **P1** | Put hard resource ceilings on guest-directed work | Define per-run limits for Wasm pages, instruction/cycle budget, wall time, frames, pixels, audio samples, output bytes, queue depth, recursion/nesting, and artifact size. Reject before allocation. |
| F-014 | **P1** | Refresh typed-array views after WebAssembly memory growth | Centralize memory access behind a view provider keyed by `memory.buffer`; reacquire views before each boundary operation and after guest calls that may grow memory. |
| F-015 | **P1** | Make cancellation and timeouts preemptive rather than cooperative | Run untrusted execution in a disposable Worker/process with instruction or cycle slicing, wall-clock watchdog, memory cap, and forced termination. Keep artifact writing outside that process. |
| F-016 | **P1** | Normalize and confine every host filesystem path | Treat all external names as identifiers, not paths. Generate internal filenames, resolve beneath a dedicated root, reject separators/control characters/case collisions, and write atomically with no-follow semantics. |
| F-017 | **P1** | Default ESP32Sim networking to no egress for untrusted firmware | Use `net=none` by default in Puck. Put optional egress behind explicit user consent and a policy layer that blocks loopback, link-local, RFC1918/ULA, multicast, metadata ranges, rebinding, and excessive flows; support destination allowlists. |
| F-018 | **P1** | Constrain local WebSocket/UI control surfaces | Bind loopback by default, use a random capability token, validate Origin/Host, cap message sizes and rates, and require an explicit flag for remote binding with TLS/authentication. |
| F-019 | **P1** | Validate every Worker/WebSocket event against a versioned schema | Define a closed discriminated schema with strict numeric bounds, maximum payload sizes, protocol version, and unknown-field policy. Validate before dispatch. |
| F-030 | **P1** | Prove host-mode parity as a product invariant | Build all modes from one host-core package and a small environment adapter. Add a parity suite that replays identical manifests and compares normalized event/result streams. |
| F-031 | **P0** | Correct the roadmap assumption that a Bus wrapper observes all memory traffic | Define observation at the CPU backend level. Either emit explicit JIT memory hooks, disable fast memory when exact observation is required, or make the fast-path metadata/accounting contract include every access. Keep one semantic oracle in the interpreter. |
| F-032 | **P1** | Put ESP32Sim behind a Puck-owned stable adapter | Create a small adapter contract: create/reset, load image, run-to-deadline, inject event, drain typed events, bounded memory inspection, capabilities, snapshot metadata, and shutdown. No Puck code outside the adapter imports upstream internals. |
| F-033 | **P1** | Specify the scheduler and virtual-time contract before peripheral work | Write an ADR defining monotonic virtual cycles, event priority/tie-breaks, CPU/device advancement, deadline semantics, host pacing separation, and what “exact” means for each test tier. |
| F-034 | **P1** | Treat the interpreter as the semantic oracle and JIT as an optional optimization | Keep interpreter support mandatory in all environments; gate JIT by capability and trust level; run differential programs across both on every relevant change. |
| F-035 | **P1** | Design snapshot and reset semantics before exposing save/restore | Version a complete deterministic snapshot schema or explicitly defer snapshots. Separate immutable board wiring from resettable chip state and non-serializable live host resources. |
| F-036 | **P1** | Make dual-core and interrupt ordering observable and testable | Document core quantum and tie-break order; expose deterministic trace events for core step, IRQ assert/accept, and device deadline; create race-sensitive litmus firmware. |
| F-047 | **P0** | Expand required CI from pack/registry checks to the actual product proof matrix | Create required jobs for formatting/lint, strict typecheck, unit tests, hostile modules, headless regressions, browser smoke/parity, pack/registry validation, Rust fmt/test/clippy, and decoder conformance with real corpora. |
| F-048 | **P0** | Make decoder conformance fail closed when corpora are absent | Split tests into a small committed mandatory corpus and a larger artifact-backed corpus. In conformance CI, missing files must be an error; print executed case counts and corpus hashes. |
| F-049 | **P1** | Grow the mandatory Rust semantic test base beyond the current smoke level | Add table/property tests for every instruction family and exception; state-machine tests for peripherals; scheduler litmus tests; and mandatory firmware boot fixtures. |
| F-050 | **P1** | Add fuzzing, property testing, sanitizers, and unsafe-code checks | Add cargo-fuzz/libFuzzer targets, property tests, Address/UndefinedBehavior sanitizers for native helpers, Miri for suitable Rust modules, and JS/Wasm hostile corpus mutation. |
| F-051 | **P1** | Make branch protection and review rules part of the documented system | Store rules as code where possible, document required repository settings, and run a periodic GitHub API audit that compares actual settings to policy. |
| F-052 | **P1** | Promote browser smoke and parity tests to required status | Run Playwright/WebDriver against a production build in at least Chromium and one second engine; exercise load, run, stop, reset, hostile module, reload/cache, and parity hashes. |
| F-053 | **P1** | Require semantic review for golden updates | Pair each golden with semantic assertions: dimensions, frame count, selected pixels/regions, event sequence, audio duration/rate/energy, serial milestones, and no unexpected warnings. Require a diff summary on update. |
| F-054 | **P1** | Record complete fixture provenance and environment | Generate a sidecar manifest for each run with all source/artifact hashes, backend capabilities, flags, virtual duration, seed, input script, host architecture, and result hashes. |
| F-064 | **P1** | Make the V2 CO5300/CST820 board the first supported hardware target | Declare V2 as the first acceptance target; freeze its wiring, timings, orientation, pixel format, touch transform, and boot fixture before adding the original revision. |
| F-065 | **P1** | Treat SH8601/FT3168 support as unvalidated inherited evidence | Label the path experimental until an original-revision board is acquired and its own boot/display/touch traces are captured. Keep interfaces ready, but do not implement speculative compatibility branches. |
| F-066 | **P1** | Capture controller transactions before coding detailed display/touch models | Capture reset/power sequence, SPI/QSPI writes, DMA descriptors, frame windows, touch I2C transactions/interrupts, and orientation transforms from real hardware. |
| F-074 | **P1** | Remove panic/unchecked assumptions from untrusted-input paths | Classify call sites by trust, replace reachable panics with typed errors, add bounds checks before indexing, and reserve assertions for internal invariants proven by validated types. |

## Full finding register

### Governance & provenance

#### F-001 — Resolve ESP32Sim’s license before treating it as a foundation [P0]

**Positive foundation.** Pinning the exact source snapshot is excellent provenance hygiene.

**Evidence.** No repository-root license file was found in the bundled ESP32Sim root `puck-esp32s3-export-2026-08-31/esp32sim`. The public GitHub repository also reports no declared license as of the review date.

**Why it matters.** Without an explicit grant, copying, modifying, distributing, or shipping the upstream code can be legally blocked even when the repository is public. Component-level licenses do not automatically license the repository as a whole.

**Recommended change.** Obtain an explicit license from the author or a signed contribution/license agreement; add a root LICENSE, NOTICE, source provenance record, and a third-party inventory before any product branch imports or modifies the code.

**Acceptance evidence.** Legal/owner approval is recorded; the exact licensed commit is named; CI verifies required license/notice files; release artifacts carry the required notices.

**Suggested owner.** Project owner / legal

#### F-002 — Turn the pinned snapshot into a reproducible upstream provenance record [P1]

**Positive foundation.** The archive and fixtures use exact hashes, which is the right foundation.

**Evidence.** Archive SHA-256 is `32dbbd6890be1787bcbe22fbb7d0f57003ec4d69d4013fbc6adad67de0c05db1`; local git metadata is recorded for both roots in the review evidence. `puck-esp32s3-export-2026-08-31/MANIFEST.md:20`, `puck-esp32s3-export-2026-08-31/MANIFEST.md:81`

**Why it matters.** A source copy without an origin URL, commit, patch stack, license state, and update policy becomes difficult to audit or refresh safely.

**Recommended change.** Create `third_party/esp32sim/PROVENANCE.md` with upstream URL, exact commit, retrieval date, archive hash, local patch series, license, and approved update procedure.

**Acceptance evidence.** A clean script can fetch the approved commit, verify its hash, apply the patch series, and reproduce the vendored tree byte-for-byte.

**Suggested owner.** Release engineering

#### F-003 — Inventory redistribution rights for ROMs, firmware blobs, fonts, audio, and calibration fixtures [P1]

**Positive foundation.** The project preserves high-value real-world fixtures rather than relying only on synthetic examples.

**Evidence.** The supplied archive contains binary fixtures and calibration material; the largest-file hash inventory is in the companion evidence. License/notice files found: 12. `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:87`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:93`

**Why it matters.** A technically reproducible test corpus can still be non-redistributable. Firmware built from third-party SDKs, mask ROM images, media, and generated assets may each have different rights.

**Recommended change.** Add an asset manifest with source, author, license/permission, whether redistribution is allowed, whether the asset may be public, and the build recipe. Keep restricted fixtures in a separately controlled store.

**Acceptance evidence.** Every non-source artifact has an owner, digest, origin, rights field, retention rule, and reproducible generation command.

**Suggested owner.** Project owner / release engineering

#### F-004 — Adopt ESP32Sim as a controlled fork, not as a stable external API [P2]

**Positive foundation.** The upstream author documents decisions and validates against hardware unusually well for an early emulator.

**Evidence.** Public repository metadata shows the project was created on 2026-08-25 and the reviewed public head was `2114ffc92039b4605264d2cfb4ee5543acbf98c1` on 2026-08-30; it had no tagged compatibility contract or declared license at review time.

**Why it matters.** Rapid, single-maintainer development is productive, but internal types and behavior can change faster than Puck can safely absorb.

**Recommended change.** Mirror/fork the approved commit, protect the fork, keep Puck-facing APIs in a narrow adapter crate/package, and upstream changes selectively after conformance review.

**Acceptance evidence.** Puck builds against one documented adapter version; upstream syncs are isolated PRs with full differential and security test results.

**Suggested owner.** Architecture / release engineering

#### F-005 — Pin CI actions and downloaded toolchain artifacts by immutable digest [P1]

**Positive foundation.** The repository already treats firmware and fixture hashes as important evidence.

**Evidence.** Workflow files inspected: puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml, puck-esp32s3-export-2026-08-31/puck/.github/workflows/verify-bundles.yml. Action references and network fetches should be checked against immutable SHAs and file digests. `puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml:39`

**Why it matters.** Tags, branches, and unverified downloads can change after review, turning CI into a supply-chain execution path.

**Recommended change.** Pin every GitHub Action to a full commit SHA, use minimal permissions, verify downloaded ROM/toolchain/archive SHA-256 values, and record approved update automation.

**Acceptance evidence.** A policy test rejects mutable `uses:` refs and network downloads without a verified digest.

**Suggested owner.** Security / release engineering

#### F-006 — Make generated fixtures visibly generated and reviewable [P2]

**Positive foundation.** Golden displays, audio, and traces provide strong regression sensitivity.

**Evidence.** The archive includes built fixtures with hashes; regression references appear in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`

**Why it matters.** When a fixture can be replaced by the same change that alters behavior, the test can silently ratify a defect.

**Recommended change.** Store generator version, exact inputs, command, expected semantic summary, and reviewer checklist next to every fixture. Split behavior changes and golden updates into distinct commits where practical.

**Acceptance evidence.** CI regenerates a sample set and compares hashes; fixture-update PRs show semantic diffs and require a second reviewer.

**Suggested owner.** Testing / release engineering

#### F-007 — Preserve the archive’s safe extraction and integrity properties [P3]

**Positive foundation.** The reviewed archive can be hashed and inventoried as a single immutable handoff.

**Evidence.** Archive scan found 0 unsafe path entries and recorded 1783 files.

**Why it matters.** Future export tooling could accidentally admit absolute paths, `..` traversal, symlinks, or mutable external references.

**Recommended change.** Keep safe-extraction checks in export/import tooling and generate a signed manifest of paths, sizes, modes, and hashes.

**Acceptance evidence.** A hostile ZIP corpus proves traversal, symlink, duplicate-path, case-folding, and oversized-entry rejection.

**Suggested owner.** Release engineering

#### F-008 — Add release-time secret scanning for both source and binaries [P2]

**Positive foundation.** The upstream history shows awareness of embedded-secret risks, and the supplied project separates fixtures from core source.

**Evidence.** Static source scan recorded 0 potential secret-shaped strings for manual triage; binary fixtures also need `strings`/entropy scanning before publication.

**Why it matters.** Credentials can survive in firmware images, source maps, test logs, browser bundles, or old fixtures even when source files are clean.

**Recommended change.** Run allowlisted secret scanners over text, git history, generated bundles, firmware strings, and release archives; redact logs and rotate any confirmed credential.

**Acceptance evidence.** A release candidate fails closed on unapproved hits, with explicit fixture allowlists tied to hashes.

**Suggested owner.** Security / release engineering

#### F-009 — Define an agent-safe change protocol [P2]

**Positive foundation.** The project’s roadmap and evidence documents give agents useful context.

**Evidence.** `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:11`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:1`

**Why it matters.** Multiple autonomous agents can independently “fix” the same boundary, update goldens, or widen APIs without sharing the same assumptions.

**Recommended change.** Require a short ADR/change brief for architecture, guest-host ABI, timing, fixture, or upstream-sync changes. Assign file ownership and one integration agent per milestone.

**Acceptance evidence.** Every qualifying PR names the invariant changed, evidence added, rollback path, and affected compatibility matrix.

**Suggested owner.** Project lead

#### F-010 — Add an explicit dependency and toolchain update policy [P3]

**Positive foundation.** The present dependency surface is small, which makes disciplined updates practical.

**Evidence.** Puck declares 0 runtime and 5 development dependencies; ESP32Sim’s Cargo workspace is similarly compact.

**Why it matters.** Unscheduled upgrades can break determinism, browser output, transpilation, or generated fixture hashes; indefinite pinning can accumulate security debt.

**Recommended change.** Pin exact toolchain versions, use scheduled update PRs, require changelog review, and rerun the full conformance matrix before merging.

**Acceptance evidence.** Lockfiles, runtime versions, and build images are immutable in release branches; automated updates are isolated and reversible.

**Suggested owner.** Release engineering

### Runtime & trust boundaries

#### F-011 — Use one mandatory guest-output validator in live, headless, replay, and verification paths [P0]

**Positive foundation.** The live canvas path already validates important framebuffer/push results—a strong start.

**Evidence.** Framebuffer/canvas and headless/replay code are separate call paths: `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:95`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:124`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:20`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:49`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:55`

**Why it matters.** A malformed firmware/module can bypass the live-path checks and crash, allocate excessively, or corrupt the headless regression path—the very path intended to be trusted proof.

**Recommended change.** Move pointer/range/dimension/stride/count validation into a pure shared boundary module. All consumers must receive validated value objects, never raw guest pointers.

**Acceptance evidence.** The same hostile module corpus is run against every host mode and produces the same typed failure without process crash, hang, allocation spike, or partial artifact.

**Suggested owner.** Runtime / test infrastructure

#### F-012 — Harden every WASI-lite import as an untrusted ABI [P0]

**Positive foundation.** A deliberately small WASI surface is much safer than importing a general host runtime.

**Evidence.** WASI-related imports, including `fd_write`, are present at `puck-esp32s3-export-2026-08-31/tinydraw/puck/README.md:25`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:7`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:14`, `puck-esp32s3-export-2026-08-31/puck/docs/abi.md:244`, `puck-esp32s3-export-2026-08-31/puck/src/wasm.ts:216`

**Why it matters.** Guest-provided iovec pointers, counts, lengths, clocks, and buffers can overflow arithmetic, cross memory bounds, trigger very large copies, or flood logs unless checked before dereference.

**Recommended change.** Implement checked `u64` arithmetic, memory-range validation after every memory refresh, caps on iovec count and total bytes, bounded UTF-8 decoding, deterministic clock/random behavior, and explicit errno returns.

**Acceptance evidence.** Property tests and hostile modules cover wraparound, out-of-bounds, zero-length edge cases, memory growth, huge counts, invalid UTF-8, closed descriptors, and log quotas.

**Suggested owner.** Runtime / security

#### F-013 — Put hard resource ceilings on guest-directed work [P1]

**Positive foundation.** The architecture is already amenable to deterministic budgeting.

**Evidence.** Guest output and memory-related code appears in `puck-esp32s3-export-2026-08-31/esp32sim/docs/wasm-plan.md:80`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/timing_verify.ts:37`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:63`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:143`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:116`

**Why it matters.** Valid-but-extreme dimensions, row counts, log sizes, event queues, sample counts, and memory pages can exhaust the browser, CI runner, or verifier without an out-of-bounds bug.

**Recommended change.** Define per-run limits for Wasm pages, instruction/cycle budget, wall time, frames, pixels, audio samples, output bytes, queue depth, recursion/nesting, and artifact size. Reject before allocation.

**Acceptance evidence.** Boundary tests hit every limit and one-past-limit case; telemetry records which quota ended a run.

**Suggested owner.** Runtime / security

#### F-014 — Refresh typed-array views after WebAssembly memory growth [P1]

**Positive foundation.** Using direct typed-array views is efficient and appropriate when lifecycle is explicit.

**Evidence.** Wasm memory construction/access points are referenced at `puck-esp32s3-export-2026-08-31/esp32sim/docs/wasm-plan.md:80`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/timing_verify.ts:37`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:63`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:143`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:116`

**Why it matters.** A `memory.grow` detaches or replaces the underlying buffer; cached views can become stale and validators can inspect a different buffer from the consumer.

**Recommended change.** Centralize memory access behind a view provider keyed by `memory.buffer`; reacquire views before each boundary operation and after guest calls that may grow memory.

**Acceptance evidence.** A hostile fixture grows memory between pointer production and host read; all modes either read the new valid range or reject deterministically.

**Suggested owner.** Runtime

#### F-015 — Make cancellation and timeouts preemptive rather than cooperative [P1]

**Positive foundation.** Headless execution already provides a natural place to enforce deterministic budgets.

**Evidence.** `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`

**Why it matters.** A guest stuck in an infinite loop, interrupt storm, or path that never yields can block the worker or CI process before host-side checks run.

**Recommended change.** Run untrusted execution in a disposable Worker/process with instruction or cycle slicing, wall-clock watchdog, memory cap, and forced termination. Keep artifact writing outside that process.

**Acceptance evidence.** An infinite-loop specimen terminates within the deadline, releases memory, and leaves no partial “passed” result.

**Suggested owner.** Runtime / test infrastructure

#### F-016 — Normalize and confine every host filesystem path [P1]

**Positive foundation.** Separating fixtures and generated outputs is a good basis for a confined workspace.

**Evidence.** Replay/build/fixture references occur in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:157`

**Why it matters.** Manifest names, test IDs, module names, or guest-supplied strings can become traversal paths, overwrite fixtures, or escape an output directory.

**Recommended change.** Treat all external names as identifiers, not paths. Generate internal filenames, resolve beneath a dedicated root, reject separators/control characters/case collisions, and write atomically with no-follow semantics.

**Acceptance evidence.** Traversal, absolute-path, symlink, device-name, Unicode-normalization, and case-folding tests cannot escape the sandbox.

**Suggested owner.** Runtime / release engineering

#### F-017 — Default ESP32Sim networking to no egress for untrusted firmware [P1]

**Positive foundation.** ESP32Sim’s user-mode network is a valuable integration capability and its browser build naturally has no raw host sockets.

**Evidence.** Network/socket code appears at `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:30`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:139`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:156`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:31`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/README.md:12`

**Why it matters.** A native NAT bridge lets arbitrary guest firmware probe localhost, private networks, developer services, cloud metadata endpoints, or exfiltrate data through DNS/HTTP. This is SSRF from a guest VM.

**Recommended change.** Use `net=none` by default in Puck. Put optional egress behind explicit user consent and a policy layer that blocks loopback, link-local, RFC1918/ULA, multicast, metadata ranges, rebinding, and excessive flows; support destination allowlists.

**Acceptance evidence.** Hostile firmware cannot reach protected address classes; DNS answers are revalidated at connect time; rate and byte limits are enforced.

**Suggested owner.** Security / networking

#### F-018 — Constrain local WebSocket/UI control surfaces [P1]

**Positive foundation.** A live board UI is an excellent observability tool.

**Evidence.** WebSocket/server references appear at Repository-wide inspection of the supplied snapshot.

**Why it matters.** A listener bound beyond loopback, missing Origin checks, or unauthenticated control messages can let another site or LAN peer operate the emulator, load firmware, or read output.

**Recommended change.** Bind loopback by default, use a random capability token, validate Origin/Host, cap message sizes and rates, and require an explicit flag for remote binding with TLS/authentication.

**Acceptance evidence.** Cross-site WebSocket attempts, oversized frames, invalid message types, and LAN connections are rejected by default.

**Suggested owner.** Security / web runtime

#### F-019 — Validate every Worker/WebSocket event against a versioned schema [P1]

**Positive foundation.** The project already uses explicit message types, which is a good protocol foundation.

**Evidence.** WebSocket/event message handling appears at `puck-esp32s3-export-2026-08-31/puck/README.md:243`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:53`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:187`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/speed-plan.md:132`, `puck-esp32s3-export-2026-08-31/esp32sim/examples/waveshare-cam/README.md:6`

**Why it matters.** Unchecked message shapes, numeric coercions, duplicate fields, large arrays, or unknown versions can produce inconsistent behavior across browser, native, and test paths.

**Recommended change.** Define a closed discriminated schema with strict numeric bounds, maximum payload sizes, protocol version, and unknown-field policy. Validate before dispatch.

**Acceptance evidence.** A protocol corpus covers missing, extra, duplicate, malformed, very large, old-version, and future-version messages in all transports.

**Suggested owner.** Runtime / web

#### F-020 — Make time, randomness, and external input explicit deterministic services [P2]

**Positive foundation.** Deterministic fixtures and exact output hashes show the project values reproducibility.

**Evidence.** WASI clock/random and replay references appear at `puck-esp32s3-export-2026-08-31/puck/README.md:14`, `puck-esp32s3-export-2026-08-31/puck/README.md:90`, `puck-esp32s3-export-2026-08-31/puck/README.md:178`, `puck-esp32s3-export-2026-08-31/puck/README.md:194`, `puck-esp32s3-export-2026-08-31/puck/README.md:195`

**Why it matters.** Reading host time, entropy, scheduling, DNS, or network responses directly makes failures irreproducible and can cause browser/headless divergence.

**Recommended change.** Inject clock, RNG seed, input event stream, and network transcript through a run context. Record them in the result manifest and separate “deterministic replay” from “live integration” modes.

**Acceptance evidence.** Repeated runs with the same manifest are byte-identical; live-mode nondeterminism is labeled and excluded from exact golden assertions.

**Suggested owner.** Runtime / testing

#### F-021 — Use a typed, fail-closed error model at the guest boundary [P2]

**Positive foundation.** The current validators demonstrate the right instinct to reject malformed results.

**Evidence.** Error/validation sites are adjacent to `puck-esp32s3-export-2026-08-31/tinydraw/puck/README.md:25`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:7`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:14`, `puck-esp32s3-export-2026-08-31/puck/docs/abi.md:244`

**Why it matters.** Generic exceptions, panics, or “best effort” continuation can convert a guest fault into partial output that looks valid or hide which invariant failed.

**Recommended change.** Return structured errors with phase, code, guest address/range (redacted as needed), quota, and recoverability. On integrity faults, stop the run and discard uncommitted artifacts.

**Acceptance evidence.** Every hostile fixture maps to one stable error code; no invalid run is reported as passed or produces a blessed golden.

**Suggested owner.** Runtime / testing

#### F-022 — Commit output atomically only after full validation [P2]

**Positive foundation.** The project’s artifact orientation makes transactional output practical.

**Evidence.** `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:65`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:74`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:75`

**Why it matters.** Writing rows, frames, logs, or audio incrementally before validation can leave partial artifacts after a late fault; CI may compare or publish them.

**Recommended change.** Stage output in bounded temporary storage, validate final metadata and hash, then atomically rename/commit. Mark incomplete runs separately.

**Acceptance evidence.** Killing a run at every write boundary never replaces the previous known-good artifact and never yields a pass marker.

**Suggested owner.** Runtime / test infrastructure

#### F-023 — Run regression verification in a disposable isolation boundary [P2]

**Positive foundation.** Headless replay is the right automation interface.

**Evidence.** `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:157`

**Why it matters.** A verifier sharing a process with untrusted Wasm, parsers, or image/audio encoders can be crashed or poisoned, invalidating the proof layer.

**Recommended change.** Split execution from adjudication: a sandboxed worker emits a capped, schema-validated result bundle; a smaller trusted verifier checks hashes and semantics in a separate process.

**Acceptance evidence.** Crashes, timeouts, and malformed result bundles become failed runs while the verifier and subsequent jobs remain healthy.

**Suggested owner.** Testing / security

#### F-024 — Cap package/archive expansion before allocation [P2]

**Positive foundation.** Content-addressed artifacts are a strong base for safe caching.

**Evidence.** `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:87`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:93`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:126`

**Why it matters.** A small compressed input or manifest can expand into an oversized module, image, trace, or nested archive and exhaust memory or disk.

**Recommended change.** Apply limits to compressed size, uncompressed total, entry count, per-entry size, nesting, compression ratio, and duplicate paths before extraction; stream hashes.

**Acceptance evidence.** ZIP-bomb, duplicate-name, nested, sparse, and huge-metadata corpora are rejected without exceeding resource budgets.

**Suggested owner.** Pack / registry

#### F-025 — Canonicalize registry and manifest identifiers once [P2]

**Positive foundation.** The registry/pack model creates a natural validation choke point.

**Evidence.** Hash/integrity and registry-oriented evidence appears in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:87`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:93`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:126`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:115`

**Why it matters.** Unicode confusables, normalization differences, path-like names, semver ambiguity, and case-folding can create duplicate identities or cache/signature mismatches.

**Recommended change.** Define ASCII or normalized identifier grammar, canonical semver, sorted canonical serialization, duplicate-key rejection, and one content digest computed over canonical bytes.

**Acceptance evidence.** Cross-runtime canonicalization vectors produce identical bytes/digests; ambiguous identifiers and duplicate JSON keys are rejected.

**Suggested owner.** Pack / registry

#### F-026 — Ship browser isolation headers and a restrictive CSP [P3]

**Positive foundation.** Running substantial emulation in a Worker is already a useful containment layer.

**Evidence.** Browser and WebAssembly code appears at `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:224`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:225`, `puck-esp32s3-export-2026-08-31/puck/server.ts:183`, `puck-esp32s3-export-2026-08-31/puck/server.ts:185`

**Why it matters.** Without a strong CSP and cross-origin isolation policy, an unrelated script compromise can control firmware inputs/outputs; future shared memory features may be enabled inconsistently.

**Recommended change.** Use no inline script where feasible, hashed/static assets, `object-src none`, narrow `connect-src`, COOP/COEP where required, and explicit worker sources. Avoid third-party runtime scripts.

**Acceptance evidence.** Automated browser tests assert response headers and show no CSP violations in supported deployment modes.

**Suggested owner.** Web / security

#### F-027 — Treat guest logs and labels as untrusted display data [P2]

**Positive foundation.** Exposing serial/log output is essential for emulator usability.

**Evidence.** `fd_write` and web UI output paths appear at `puck-esp32s3-export-2026-08-31/tinydraw/puck/README.md:25`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:7`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:14`, `puck-esp32s3-export-2026-08-31/puck/docs/abi.md:244`

**Why it matters.** ANSI control sequences, terminal hyperlinks, bidi controls, HTML injection, huge lines, and high-rate output can spoof diagnostics or degrade the UI.

**Recommended change.** Render as text, strip or visibly encode dangerous controls, cap line length/rate/total bytes, and preserve raw bytes only in a quarantined downloadable artifact.

**Acceptance evidence.** A log-fuzz corpus cannot inject DOM, hide prior text, create links, or exceed quotas.

**Suggested owner.** Runtime / web

#### F-028 — Version and quota persistent browser state [P2]

**Positive foundation.** Persisted packs and fixtures can make iteration fast and offline-friendly.

**Evidence.** Browser/package-related code appears at `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:224`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:225`, `puck-esp32s3-export-2026-08-31/puck/server.ts:183`, `puck-esp32s3-export-2026-08-31/puck/server.ts:185`

**Why it matters.** Unbounded IndexedDB/cache state, schema drift, or partially written entries can strand users or cause old code to load incompatible modules.

**Recommended change.** Use content-addressed entries, per-origin quotas, schema version/migrations, atomic writes, LRU cleanup, and a safe reset path.

**Acceptance evidence.** Upgrade/downgrade/corruption tests recover without loading unverified content or losing unrelated user data.

**Suggested owner.** Web / pack

#### F-029 — Define interrupt-storm and event-queue backpressure behavior [P2]

**Positive foundation.** The emulator roadmap recognizes timing and peripheral events as first-class behavior.

**Evidence.** Timing/Bus/JIT and push/event references appear at `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`, `puck-esp32s3-export-2026-08-31/puck/README.md:169`, `puck-esp32s3-export-2026-08-31/puck/README.md:282`

**Why it matters.** A guest can generate events faster than rendering, audio, networking, or tracing consumers can process them, causing memory growth or timing distortion.

**Recommended change.** Use bounded queues, coalescing rules for replaceable state, explicit drop counters, and deterministic backpressure for lossless channels.

**Acceptance evidence.** Stress tests sustain maximum event rates with bounded memory and documented loss/latency behavior.

**Suggested owner.** Runtime / architecture

#### F-030 — Prove host-mode parity as a product invariant [P1]

**Positive foundation.** The same project supports interactive use and automated proof, which is strategically valuable.

**Evidence.** Live canvas, headless, and replay references span `puck-esp32s3-export-2026-08-31/puck/README.md:243`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:53`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:187`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/speed-plan.md:132`, `puck-esp32s3-export-2026-08-31/esp32sim/examples/waveshare-cam/README.md:6`, `puck-esp32s3-export-2026-08-31/esp32sim/examples/waveshare-cam/run-autopling.sh:3`

**Why it matters.** Separate implementations can drift in imports, validation, timing, defaults, and error handling, creating “passes headless, fails live” or the reverse.

**Recommended change.** Build all modes from one host-core package and a small environment adapter. Add a parity suite that replays identical manifests and compares normalized event/result streams.

**Acceptance evidence.** Every conformance fixture yields identical semantic events, errors, hashes, and quota accounting across supported modes.

**Suggested owner.** Architecture / testing

### ESP32Sim architecture & integration

#### F-031 — Correct the roadmap assumption that a Bus wrapper observes all memory traffic [P0]

**Positive foundation.** The roadmap wisely seeks a narrow timing/observation seam instead of scattering instrumentation.

**Evidence.** ESP32Sim exposes fast-memory/JIT paths at `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/bus.rs:59`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32s3/src/bus.rs:622`

**Why it matters.** The native JIT probes the TLB and performs host loads/stores directly on fast paths. Those operations bypass ordinary `Bus` read/write methods, so a wrapper around the trait cannot see all accesses or enforce complete timing/accounting.

**Recommended change.** Define observation at the CPU backend level. Either emit explicit JIT memory hooks, disable fast memory when exact observation is required, or make the fast-path metadata/accounting contract include every access. Keep one semantic oracle in the interpreter.

**Acceptance evidence.** A conformance program exercises RAM, flash, MMIO, faults, self-modifying code, and cross-page accesses; interpreter, JIT-fast, and JIT-hooked modes produce identical observations and timing.

**Suggested owner.** CPU / architecture

#### F-032 — Put ESP32Sim behind a Puck-owned stable adapter [P1]

**Positive foundation.** ESP32Sim already separates CPU, SoC, board, CLI, and web concerns—excellent raw material for an adapter.

**Evidence.** CPU/SoC/board and Bus-related structure is visible around `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`, `puck-esp32s3-export-2026-08-31/puck/README.md:169`, `puck-esp32s3-export-2026-08-31/puck/README.md:282`

**Why it matters.** Direct imports of internal machine, bus, peripheral, JIT, or web types will make upstream syncs expensive and let implementation details leak into Puck’s model.

**Recommended change.** Create a small adapter contract: create/reset, load image, run-to-deadline, inject event, drain typed events, bounded memory inspection, capabilities, snapshot metadata, and shutdown. No Puck code outside the adapter imports upstream internals.

**Acceptance evidence.** A dependency rule/lint test enforces the boundary; a fake backend and the ESP32Sim backend pass the same contract suite.

**Suggested owner.** Architecture

#### F-033 — Specify the scheduler and virtual-time contract before peripheral work [P1]

**Positive foundation.** Both projects already care about exact output timing and deterministic regression.

**Evidence.** Timing/roadmap references appear in `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:11`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:61` and fast-path timing in `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`

**Why it matters.** Without a written definition of cycle ownership, deadlines, device flushes, host pacing, and simultaneous events, two correct-looking implementations can diverge at interrupts, DMA completion, touch polling, or audio boundaries.

**Recommended change.** Write an ADR defining monotonic virtual cycles, event priority/tie-breaks, CPU/device advancement, deadline semantics, host pacing separation, and what “exact” means for each test tier.

**Acceptance evidence.** Table-driven scheduler tests cover same-cycle IRQs, DMA completion, timer compare, reset, sleep, and host input at boundaries.

**Suggested owner.** Architecture / timing

#### F-034 — Treat the interpreter as the semantic oracle and JIT as an optional optimization [P1]

**Positive foundation.** ESP32Sim’s `--no-jit` path and bit-identical comparisons are a particularly valuable design choice.

**Evidence.** JIT and interpreter references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/bus.rs:59`

**Why it matters.** A native-code backend increases unsafe-code, executable-memory, invalidation, and architecture-specific risk. It must not become the only path capable of running tests or observing behavior.

**Recommended change.** Keep interpreter support mandatory in all environments; gate JIT by capability and trust level; run differential programs across both on every relevant change.

**Acceptance evidence.** Release CI includes interpreter/JIT differential suites; untrusted/headless proof mode can disable JIT without losing functionality.

**Suggested owner.** CPU / security

#### F-035 — Design snapshot and reset semantics before exposing save/restore [P1]

**Positive foundation.** The model already distinguishes chip, board, and runtime state, which is a good basis for snapshots.

**Evidence.** Reset/replay concepts appear in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`

**Why it matters.** A partial snapshot that omits pending DMA, device deadlines, TLB/JIT versions, network state, RNG, or host queues can resume into impossible state and invalidate regressions.

**Recommended change.** Version a complete deterministic snapshot schema or explicitly defer snapshots. Separate immutable board wiring from resettable chip state and non-serializable live host resources.

**Acceptance evidence.** Save/restore at randomized cycle boundaries yields the same final event hash as uninterrupted execution, or the capability is absent rather than partial.

**Suggested owner.** Architecture / runtime

#### F-036 — Make dual-core and interrupt ordering observable and testable [P1]

**Positive foundation.** ESP32Sim’s deterministic scheduling is more suitable for regression than unconstrained host threading.

**Evidence.** CPU/interrupt timing concepts are present in `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:3`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:4`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:9`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:10`

**Why it matters.** Small changes in core interleave, interrupt sampling, or device flush timing can alter FreeRTOS behavior while still producing plausible output.

**Recommended change.** Document core quantum and tie-break order; expose deterministic trace events for core step, IRQ assert/accept, and device deadline; create race-sensitive litmus firmware.

**Acceptance evidence.** Litmus tests and real-hardware traces pin ordering; changing the policy requires an ADR and fixture review.

**Suggested owner.** CPU / timing

#### F-037 — Assign one authoritative owner for each address range and peripheral event [P2]

**Positive foundation.** The CPU/SoC/board layering makes ownership explicit enough to formalize.

**Evidence.** Bus/peripheral references appear at `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`, `puck-esp32s3-export-2026-08-31/puck/README.md:169`, `puck-esp32s3-export-2026-08-31/puck/README.md:282`

**Why it matters.** Overlapping maps, mirrored ranges, “default zero” reads, and duplicated device ticks can hide unsupported behavior and make debugging nonlinear.

**Recommended change.** Generate an address-map registry with range, access widths, reset values, owner, side effects, unsupported policy, and test status. Reject overlaps unless declared aliases.

**Acceptance evidence.** A map audit test detects overlap/gaps; unknown accesses are traceable and can be configured to fault in strict mode.

**Suggested owner.** SoC / peripheral architecture

#### F-038 — Keep board revision and wiring data declarative [P2]

**Positive foundation.** The project already distinguishes board-level evidence from generic SoC work.

**Evidence.** Board revision references appear at `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:155`, `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:158`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:13`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:49`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:12`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:91`

**Why it matters.** Conditionals spread across display, touch, GPIO, and scripts make revision support difficult to test and easy to mix accidentally.

**Recommended change.** Define a versioned board manifest for flash/PSRAM, pins, buses, display/touch controllers, geometry, polarity, clock limits, and fixtures; construct models from it.

**Acceptance evidence.** Both revisions parse through one schema; invalid or incomplete wiring fails before boot; generated documentation matches the manifest.

**Suggested owner.** Board architecture

#### F-039 — Publish a native/browser capability matrix [P2]

**Positive foundation.** ESP32Sim’s browser build is a major strategic advantage.

**Evidence.** WebAssembly and network/JIT code paths appear at `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:224`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:225`, `puck-esp32s3-export-2026-08-31/puck/server.ts:183`, `puck-esp32s3-export-2026-08-31/puck/server.ts:185`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/speed-plan.md:117`

**Why it matters.** Native and browser builds differ materially: JIT, sockets/NAT, filesystem, performance, threads, and possibly timers. A single “supported” label can mislead users and tests.

**Recommended change.** Expose machine-readable capabilities and document support levels by backend. Tests should skip only with an explicit unsupported capability—not silently due to missing files.

**Acceptance evidence.** The UI and CLI report capabilities; the matrix is generated from code and checked against conformance results.

**Suggested owner.** Architecture / documentation

#### F-040 — Gate performance work on semantic and security invariants [P2]

**Positive foundation.** Upstream performance work is measured and often compared against bit-identical outputs, which is excellent practice.

**Evidence.** Fast memory/JIT references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/bus.rs:59`

**Why it matters.** Optimization can bypass validation, instrumentation, version checks, or exact timing—as the Bus observation gap demonstrates.

**Recommended change.** Require a checklist for every fast path: semantic oracle comparison, boundary hooks, quota accounting, invalidation, fault behavior, deterministic output, and hostile-input tests.

**Acceptance evidence.** No performance PR merges without before/after conformance hashes and security-boundary coverage; speed results are secondary acceptance evidence.

**Suggested owner.** CPU / performance

#### F-041 — Define the firmware and ESP-IDF compatibility promise [P2]

**Positive foundation.** Booting unmodified firmware and real ROMs is a compelling product direction.

**Evidence.** `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:3`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:4`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:9`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:10`

**Why it matters.** “ESP32-S3 compatible” can mean booting one fixture, one IDF family, or broad silicon behavior. New IDF releases exercise new ROM calls, peripheral modes, and security paths.

**Recommended change.** Publish tested IDF/Arduino versions, boot modes, chips, board revisions, and peripheral feature levels. Add representative firmware per supported band and label everything else experimental.

**Acceptance evidence.** Each release carries a generated compatibility report with exact toolchain and firmware hashes.

**Suggested owner.** Product / test architecture

#### F-042 — Create an explicit upstream API/ABI version [P2]

**Positive foundation.** The source layout is modular enough to expose a deliberately small public surface.

**Evidence.** Workspace structure and adapter-relevant symbols appear around `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:3`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:4`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:9`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:10`

**Why it matters.** Without versioned behavior, Puck cannot tell whether an upstream update changed event semantics, timing, or only implementation.

**Recommended change.** Version the adapter protocol and event schema independently of package version; require capability negotiation and reject incompatible major versions.

**Acceptance evidence.** Old fixture manifests either continue to run under a compatibility layer or fail with a clear version error.

**Suggested owner.** Architecture

#### F-043 — Security-review bespoke JIT, crypto, packet, and image/audio parsing surfaces [P2]

**Positive foundation.** A low external dependency count reduces third-party supply-chain exposure.

**Evidence.** Unsafe/JIT and network patterns appear at `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:98`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:104`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:105`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:106`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:107`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:112` and `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:30`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:139`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:156`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:31`

**Why it matters.** Low dependencies shift responsibility into project code. Raw-pointer JIT helpers, executable memory, packet parsers, decompression/image code, and custom crypto arithmetic are high-consequence host attack surfaces when firmware is untrusted.

**Recommended change.** Inventory every `unsafe` block and parser, state safety invariants, isolate JIT, fuzz byte-oriented inputs, run sanitizers/Miri where applicable, and prefer audited libraries for host-security functions.

**Acceptance evidence.** Unsafe-code review has owners; fuzz targets run continuously; sanitizer builds are clean; untrusted mode can disable high-risk optional features.

**Suggested owner.** Security / upstream fork

#### F-044 — Separate emulated correctness from host-service convenience [P2]

**Positive foundation.** ESP32Sim’s virtual AP/NAT and host UI make real applications demonstrable.

**Evidence.** Network and web service code appears at `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:30`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:139`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:156`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:31`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/README.md:12`

**Why it matters.** Host clock, DNS, NAT, WebSockets, and filesystem output are conveniences, not silicon. Mixing them into machine semantics complicates determinism and widens trusted code.

**Recommended change.** Keep host services behind interfaces with deterministic transcript implementations for tests and policy-enforced live implementations for demos.

**Acceptance evidence.** The same firmware can run with `none`, deterministic transcript, and live service providers; machine-state hashes exclude non-semantic host timing.

**Suggested owner.** Architecture / security

#### F-045 — Set honest performance expectations per host architecture [P3]

**Positive foundation.** Upstream publishes measured workloads instead of one synthetic headline number.

**Evidence.** JIT-specific code and browser paths appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/bus.rs:59`

**Why it matters.** The native JIT is architecture-specific; x86 and WebAssembly can use different execution engines and therefore different throughput and risk profiles.

**Recommended change.** Benchmark a small canonical suite on supported macOS/Linux/Windows architectures and browser engines; publish median and worst-case real-time factors with JIT status.

**Acceptance evidence.** Release notes contain reproducible benchmark manifests and no cross-host extrapolation.

**Suggested owner.** Performance / product

#### F-046 — Use a small, reviewable patch stack for the fork [P2]

**Positive foundation.** The upstream project is active enough that selective synchronization may be valuable.

**Evidence.** Local and public commit metadata are recorded in the review evidence; the public head may continue moving quickly.

**Why it matters.** A long-lived fork with mixed product features and upstream fixes becomes difficult to audit, license, or rebase.

**Recommended change.** Keep Puck-specific behavior in adapter/board crates where possible; maintain upstream commits as clean cherry-picks and product patches as separately labeled commits.

**Acceptance evidence.** An automated range-diff summarizes every upstream sync and the conformance suite runs before and after it.

**Suggested owner.** Architecture / release engineering

### Testing, CI & evidence

#### F-047 — Expand required CI from pack/registry checks to the actual product proof matrix [P0]

**Positive foundation.** The existing required workflow establishes a useful starting gate for artifact integrity.

**Evidence.** Inspected workflow commands: `puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml:25` → `tools/wasm-build.sh`; `puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml:27` → `|`; `puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml:36` → `|`; `puck-esp32s3-export-2026-08-31/puck/.github/workflows/verify-bundles.yml:39` → `|`; `puck-esp32s3-export-2026-08-31/puck/.github/workflows/verify-bundles.yml:54` → `bun run tools/ci-verify-registry.ts`; `puck-esp32s3-export-2026-08-31/puck/.github/workflows/verify-bundles.yml:57` → `bun run pack:esp32:gate`. The reviewed required slice does not enforce the full typecheck, hostile-host, regression, browser, and ESP32Sim Rust matrix described by the project.

**Why it matters.** Safeguards that are not required checks can regress while PRs remain green; prose and local scripts are not enforcement.

**Recommended change.** Create required jobs for formatting/lint, strict typecheck, unit tests, hostile modules, headless regressions, browser smoke/parity, pack/registry validation, Rust fmt/test/clippy, and decoder conformance with real corpora.

**Acceptance evidence.** Branch rules require every job; a deliberately broken validator, fixture, type, browser path, and Rust decoder each causes the expected required job to fail.

**Suggested owner.** CI / project lead

#### F-048 — Make decoder conformance fail closed when corpora are absent [P0]

**Positive foundation.** Differential decoding against vendor/objdump output is exactly the right high-value oracle.

**Evidence.** External decoder corpus variables and skip paths appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/cli.md:61`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/testing-plan.md:39`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/tests/objdump_diff.rs:3`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/tests/objdump_diff.rs:25`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/esp32c3.md:126`, `puck-esp32s3-export-2026-08-31/esp32sim/riscv-rv32/tests/objdump_diff.rs:3`, `puck-esp32s3-export-2026-08-31/esp32sim/riscv-rv32/tests/objdump_diff.rs:26`, `puck-esp32s3-export-2026-08-31/esp32sim/riscv-rv32/tests/objdump_diff.rs:27`

**Why it matters.** A test that returns success when files are missing converts the headline conformance claim into an optional local check. CI can report green without running it.

**Recommended change.** Split tests into a small committed mandatory corpus and a larger artifact-backed corpus. In conformance CI, missing files must be an error; print executed case counts and corpus hashes.

**Acceptance evidence.** Required logs report nonzero Xtensa and RISC-V case counts and exact corpus digests; removing the artifact makes the job fail, not skip.

**Suggested owner.** CPU testing / CI

#### F-049 — Grow the mandatory Rust semantic test base beyond the current smoke level [P1]

**Positive foundation.** The existing tests cover important decoder and cryptographic examples, and the codebase remains small enough to improve quickly.

**Evidence.** Observed cargo test summary: the default suite is small and the decoder headline depends on external inputs. Previous direct inspection found only 13 default tests before optional decoder corpora were supplied.

**Why it matters.** A full CPU/SoC emulator can pass a small suite while instruction corner cases, exceptions, memory faults, MMU invalidation, peripheral timing, and reset behavior remain untested.

**Recommended change.** Add table/property tests for every instruction family and exception; state-machine tests for peripherals; scheduler litmus tests; and mandatory firmware boot fixtures.

**Acceptance evidence.** Coverage reports meaningful semantic categories, not only lines; every modeled peripheral and instruction family has positive, boundary, and fault tests.

**Suggested owner.** Upstream fork / testing

#### F-050 — Add fuzzing, property testing, sanitizers, and unsafe-code checks [P1]

**Positive foundation.** The deterministic cores and parsers are excellent candidates for automated generative testing.

**Evidence.** Unsafe, panic, and parser-adjacent patterns appear at `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0005-rca-core1-dies-on-first-button.md:80`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:98`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:104`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:105`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:106`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:107`

**Why it matters.** Handwritten decoders, JIT encoders, memory maps, WASI imports, packets, manifests, and image/audio paths have combinatorial input spaces that examples will not cover.

**Recommended change.** Add cargo-fuzz/libFuzzer targets, property tests, Address/UndefinedBehavior sanitizers for native helpers, Miri for suitable Rust modules, and JS/Wasm hostile corpus mutation.

**Acceptance evidence.** Nightly jobs run bounded fuzz campaigns, preserve minimized reproducers, and show zero sanitizer/Miri findings on the supported subset.

**Suggested owner.** Security testing

#### F-051 — Make branch protection and review rules part of the documented system [P1]

**Positive foundation.** The project already has governance-oriented documentation.

**Evidence.** Workflow files exist at puck-esp32s3-export-2026-08-31/esp32sim/.github/workflows/pages.yml, puck-esp32s3-export-2026-08-31/puck/.github/workflows/verify-bundles.yml, but branch-rule state is not contained in a source archive.

**Why it matters.** Required checks, signed commits, review counts, and force-push policy can silently differ from the documented development process.

**Recommended change.** Store rules as code where possible, document required repository settings, and run a periodic GitHub API audit that compares actual settings to policy.

**Acceptance evidence.** An audit job reports protected default branch, required checks, restricted force pushes/deletion, and review requirements.

**Suggested owner.** Project lead / repository administration

#### F-052 — Promote browser smoke and parity tests to required status [P1]

**Positive foundation.** A browser-native emulator is a core differentiator, not a secondary demo.

**Evidence.** Browser/WebAssembly paths appear at `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:224`, `puck-esp32s3-export-2026-08-31/puck/AGENTS.md:225`, `puck-esp32s3-export-2026-08-31/puck/server.ts:183`, `puck-esp32s3-export-2026-08-31/puck/server.ts:185`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/speed-plan.md:117`

**Why it matters.** Typechecks and headless tests will not catch Worker startup, CSP, cache, structured-clone, audio/canvas, memory-growth, and lifecycle failures.

**Recommended change.** Run Playwright/WebDriver against a production build in at least Chromium and one second engine; exercise load, run, stop, reset, hostile module, reload/cache, and parity hashes.

**Acceptance evidence.** Browser jobs are required, deterministic, capture console errors, and fail on uncaught rejection, CSP violation, resource leak, or result mismatch.

**Suggested owner.** Web testing / CI

#### F-053 — Require semantic review for golden updates [P1]

**Positive foundation.** Bit-identical display/audio/trace fixtures are powerful change detectors.

**Evidence.** Regression/golden behavior is referenced in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:157`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:187`

**Why it matters.** Goldens answer “did it change,” not “is it correct.” A bug can be accepted by regenerating all outputs.

**Recommended change.** Pair each golden with semantic assertions: dimensions, frame count, selected pixels/regions, event sequence, audio duration/rate/energy, serial milestones, and no unexpected warnings. Require a diff summary on update.

**Acceptance evidence.** A fixture update cannot merge without a machine-generated semantic diff and reviewer acknowledgement of each changed invariant.

**Suggested owner.** Testing / project lead

#### F-054 — Record complete fixture provenance and environment [P1]

**Positive foundation.** Exact fixture hashes are already a strong start.

**Evidence.** Integrity references appear in `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:87`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:93`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:126`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:115`

**Why it matters.** A hash alone does not explain which firmware, board config, seed, clock, emulator commit, toolchain, or event script produced it.

**Recommended change.** Generate a sidecar manifest for each run with all source/artifact hashes, backend capabilities, flags, virtual duration, seed, input script, host architecture, and result hashes.

**Acceptance evidence.** A fixture is rejected if any required provenance field is missing; one command reproduces it from approved inputs.

**Suggested owner.** Testing / release engineering

#### F-055 — Automate a small hardware-in-the-loop oracle [P2]

**Positive foundation.** The project has real-silicon receipts, which are more valuable than speculative datasheet interpretation.

**Evidence.** Board/calibration references appear at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:3`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:51`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:58`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:128`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:40`

**Why it matters.** Manual hardware captures are hard to rerun and can drift from the firmware/config used by the emulator.

**Recommended change.** Create a controlled HIL job or scheduled lab run that flashes exact firmware, captures serial/JTAG/display/touch traces, normalizes nondeterministic fields, and publishes signed artifacts.

**Acceptance evidence.** At least one boot/timer/GPIO/display/touch specimen per supported board revision is periodically compared with emulator output.

**Suggested owner.** Hardware validation

#### F-056 — Test validators by mutation, not only handpicked bad cases [P2]

**Positive foundation.** Hostile-module awareness is already present in the project’s design.

**Evidence.** Hostile/malformed references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/testing-plan.md:364`, `puck-esp32s3-export-2026-08-31/puck/docs/decisions/0005-external-ports-are-reproduced.md:77`, `puck-esp32s3-export-2026-08-31/puck/docs/decisions/0005-external-ports-are-reproduced.md:79`, `puck-esp32s3-export-2026-08-31/puck/docs/findings-first-adversarial-pass.md:1`, `puck-esp32s3-export-2026-08-31/puck/docs/findings-first-adversarial-pass.md:4`

**Why it matters.** Handwritten invalid fixtures often miss arithmetic combinations, stale-memory timing, duplicate messages, and near-limit cases.

**Recommended change.** Generate mutations of valid modules/manifests/events: pointers, lengths, dimensions, counts, alignment, memory growth, output ordering, and truncation. Minimize and retain failures.

**Acceptance evidence.** Mutation score is tracked; each validator branch is killed by at least one mutation across every host mode.

**Suggested owner.** Security testing

#### F-057 — Add fault-injection campaigns for peripheral and host failures [P2]

**Positive foundation.** The architecture has explicit boundaries where faults can be injected cleanly.

**Evidence.** Peripheral, replay, and network references appear at `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`, `puck-esp32s3-export-2026-08-31/puck/README.md:169`, `puck-esp32s3-export-2026-08-31/puck/README.md:282`

**Why it matters.** Real systems see short reads, DMA faults, malformed packets, missing devices, reset mid-transfer, disk-full, worker termination, and browser context loss.

**Recommended change.** Introduce deterministic fault schedules at bus, device, filesystem, network, Worker, and artifact-commit boundaries; assert safe recovery or clear terminal failure.

**Acceptance evidence.** Every boundary has at least one injected failure test and no fault can produce a false pass or corrupt known-good fixtures.

**Suggested owner.** Testing / runtime

#### F-058 — Measure boundary coverage, not only source-line coverage [P2]

**Positive foundation.** The project’s architecture documents provide a natural inventory of boundaries.

**Evidence.** `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:11`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:1`

**Why it matters.** High line coverage can coexist with untested modes, error paths, capabilities, instruction families, and peripheral states.

**Recommended change.** Maintain a coverage matrix for host modes × guest behaviors × backends × board revisions × trust faults. Use code coverage as supporting evidence, not the sole metric.

**Acceptance evidence.** Release reports show no empty cells for required boundaries and explain experimental cells explicitly.

**Suggested owner.** Test architecture

#### F-059 — Enforce timeouts, leak checks, and clean shutdown in tests [P2]

**Positive foundation.** Deterministic virtual-time tests can be both strict and fast.

**Evidence.** Headless and Worker/runtime references appear at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:38`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:53`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:149`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:157`

**Why it matters.** A test can pass while leaving Workers, sockets, timers, temp files, executable mappings, or queued messages alive, creating order-dependent CI failures.

**Recommended change.** Wrap each integration test with wall timeout, resource baseline/delta checks, temp-dir isolation, explicit shutdown, and post-test open-handle detection.

**Acceptance evidence.** Tests pass in randomized order and repeated loops with stable memory, descriptor, process, and temporary-file counts.

**Suggested owner.** Testing / runtime

#### F-060 — Pin the complete build toolchain, not only dependencies [P2]

**Positive foundation.** Lockfiles and exact artifacts support reproducibility.

**Evidence.** Package manager metadata: `None`; engines: `None`. Tool-version probe results are in the companion test log.

**Why it matters.** Bun/Node/Rust/LLVM/browser/ESP-IDF changes can alter emitted Wasm, decoding, floating behavior, fixtures, or CI scripts without a source change.

**Recommended change.** Pin versions through toolchain files/container digests; print them in every result manifest; provide a hermetic bootstrap path.

**Acceptance evidence.** Two clean machines build byte-identical or explicitly normalized artifacts from the same source and toolchain image.

**Suggested owner.** Release engineering

#### F-061 — Generate attestations and an SBOM for release artifacts [P2]

**Positive foundation.** The project’s content hashes make attestation straightforward.

**Evidence.** Hashing/integrity evidence appears at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:87`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:93`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:126`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:115`

**Why it matters.** Users and future maintainers need to know which source, tools, dependencies, firmware, and upstream fork produced a browser bundle or native binary.

**Recommended change.** Generate SPDX/CycloneDX SBOMs, provenance attestations, checksums, license notices, and signed release manifests in a protected release workflow.

**Acceptance evidence.** A release verifier can validate artifact digest, source commit, builder identity, dependency graph, and license inventory offline.

**Suggested owner.** Release engineering / security

#### F-062 — Check documentation links, claims, and generated matrices in CI [P3]

**Positive foundation.** The documentation is unusually substantive and deserves to remain trustworthy.

**Evidence.** Documentation/roadmap references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:11`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:61`

**Why it matters.** Fast implementation can leave roadmap status, support tables, commands, and performance claims stale even when code is correct.

**Recommended change.** Lint links and commands, generate capability/test matrices from source, and require measured claims to name workload, commit, backend, and host.

**Acceptance evidence.** Documentation CI detects stale paths and unsupported claims; generated sections have a clear source marker.

**Suggested owner.** Documentation

#### F-063 — Keep performance benchmarks statistically and semantically disciplined [P3]

**Positive foundation.** ESP32Sim’s upstream history shows careful interleaved measurements and output comparisons—preserve that standard.

**Evidence.** Performance/JIT paths appear around `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`

**Why it matters.** Single-run numbers, warmed caches, host background load, or different semantic modes can create misleading gains.

**Recommended change.** Use pinned workloads, interleaved A/B runs, warmup policy, multiple samples, confidence summaries, fixed host power settings where possible, and semantic hash checks.

**Acceptance evidence.** Benchmark reports are machine-generated and reject comparisons when outputs, feature flags, or instruction counts differ.

**Suggested owner.** Performance

### Board scope & roadmap

#### F-064 — Make the V2 CO5300/CST820 board the first supported hardware target [P1]

**Positive foundation.** The supplied project has stronger direct evidence for this revision, including calibration and a proven banded DMA approach.

**Evidence.** V2/controller references appear at `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:155`, `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:158`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:13`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:49`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:12`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:91`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/CMakeLists.txt:13`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/platform/puck_platform.h:8`

**Why it matters.** Trying to implement two display/touch stacks at once multiplies unknowns and makes failures hard to localize.

**Recommended change.** Declare V2 as the first acceptance target; freeze its wiring, timings, orientation, pixel format, touch transform, and boot fixture before adding the original revision.

**Acceptance evidence.** One V2 firmware boots, renders known TinyDraw scenes, accepts scripted touch, and matches hardware captures within documented tolerances.

**Suggested owner.** Board / product

#### F-065 — Treat SH8601/FT3168 support as unvalidated inherited evidence [P1]

**Positive foundation.** Retaining the earlier revision’s notes is useful research, not wasted work.

**Evidence.** Original-controller references appear at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:51`, `puck-esp32s3-export-2026-08-31/puck/packs/esp32-s3-touch-amoled-18/gotchas.md:26`, `puck-esp32s3-export-2026-08-31/puck/packs/esp32-s3-touch-amoled-18/gotchas.md:27`, `puck-esp32s3-export-2026-08-31/puck/packs/web/AGENTS.md:73`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/AGENTS.md:44`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/AGENTS.md:337`

**Why it matters.** A driver or trace from a related project does not prove this board’s reset, bus mode, command set, geometry, timing, or touch transform. Calling it supported too early would create false confidence.

**Recommended change.** Label the path experimental until an original-revision board is acquired and its own boot/display/touch traces are captured. Keep interfaces ready, but do not implement speculative compatibility branches.

**Acceptance evidence.** Support status changes only after board-specific hardware evidence and the same conformance suite used for V2.

**Suggested owner.** Board / product

#### F-066 — Capture controller transactions before coding detailed display/touch models [P1]

**Positive foundation.** TinyDraw and calibration assets provide excellent expected visuals.

**Evidence.** Display/touch/controller references appear at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:3`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:51`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:58`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:128`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:40`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:368`

**Why it matters.** Visual output alone cannot distinguish wrong initialization, pixel packing, address windows, tearing behavior, touch latching, or timing that happens to work in one scene.

**Recommended change.** Capture reset/power sequence, SPI/QSPI writes, DMA descriptors, frame windows, touch I2C transactions/interrupts, and orientation transforms from real hardware.

**Acceptance evidence.** The model replays captured transactions and passes controller-level assertions before full firmware goldens are accepted.

**Suggested owner.** Board / hardware validation

#### F-067 — Preserve banded DMA, but specify memory and backpressure invariants [P2]

**Positive foundation.** The banded design is a strong, practical response to display memory pressure.

**Evidence.** Framebuffer/push and board references appear at `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:65`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:74`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:75`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:78`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:273`

**Why it matters.** Without explicit maximum band size, stride/alignment, ownership, queue depth, and completion semantics, the optimization can introduce overruns or visual tearing.

**Recommended change.** Document buffer ownership and lifecycle, prevalidate all band geometry, cap in-flight bands, and test odd widths, last partial band, orientation, and slow-consumer behavior.

**Acceptance evidence.** Memory use stays below a fixed ceiling; randomized band layouts reproduce the full-frame reference exactly and never write outside buffers.

**Suggested owner.** Display runtime

#### F-068 — Model reset, flash, PSRAM, and boot conditions before rich peripherals [P2]

**Positive foundation.** ESP32Sim’s real-ROM/full-boot capability is the correct foundation for realistic firmware.

**Evidence.** Boot/board/SoC references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:3`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:4`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:9`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:10`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:17`

**Why it matters.** Peripheral demos can appear healthy while reset cause, straps, flash size/mode, partition offsets, PSRAM mapping, or retained state are wrong.

**Recommended change.** Create a board boot contract and conformance fixture for power-on, software reset, watchdog reset, flash/PSRAM geometry, straps, and partition loading.

**Acceptance evidence.** Boot logs and selected register/memory checkpoints match real hardware for each supported reset mode.

**Suggested owner.** SoC / board

#### F-069 — Stage Wi-Fi/BLE after deterministic local board behavior [P2]

**Positive foundation.** ESP32Sim demonstrates impressive unmodified Wi-Fi progress, so this can be a later differentiator.

**Evidence.** Network/Wi-Fi code appears at `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:30`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:139`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:156`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:31`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/README.md:12`

**Why it matters.** Radio blobs, virtual AP behavior, crypto accelerators, NAT, host DNS/time, and nondeterminism greatly widen the model and security surface.

**Recommended change.** First ship offline boot/display/touch/audio/GPIO. Add deterministic scripted network transcripts next, then opt-in live NAT; treat BLE as a separate milestone with its own evidence.

**Acceptance evidence.** Each networking tier has explicit capabilities, security policy, deterministic tests, and no effect on offline conformance.

**Suggested owner.** Product / networking

#### F-070 — Make hardware evidence a release artifact, not tribal knowledge [P2]

**Positive foundation.** The current real-silicon receipts are a major strength.

**Evidence.** Calibration/board references appear at `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:3`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:51`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:58`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:128`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:40`

**Why it matters.** Screenshots or notes without exact firmware and capture metadata are difficult for future agents to reproduce or challenge.

**Recommended change.** Store normalized traces, photos/screenshots, logic captures, firmware hashes, board serial/revision, probe scripts, and interpretation notes under a signed evidence manifest.

**Acceptance evidence.** Every hardware-backed claim in the support matrix links to a reproducible evidence bundle.

**Suggested owner.** Hardware validation / documentation

#### F-071 — Detect or require board revision explicitly [P2]

**Positive foundation.** Separate manifests make multiple revisions manageable.

**Evidence.** Revision/controller evidence appears at `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:155`, `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:158`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:13`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:49`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:12`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:91`

**Why it matters.** Silently assuming a controller can send incompatible initialization commands or misinterpret touch coordinates.

**Recommended change.** Use a trusted build/manifest selection or safe read-only probe where hardware permits; display the selected revision and reject ambiguous configurations.

**Acceptance evidence.** Wrong-revision fixtures fail early with a clear diagnostic, never with a blank screen or partially working touch.

**Suggested owner.** Board runtime

#### F-072 — Lock down pixel format, endian, stride, clipping, and orientation with property tests [P2]

**Positive foundation.** TinyDraw calibration material is well suited to precise visual conformance.

**Evidence.** Framebuffer and controller references appear at `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:155`, `puck-esp32s3-export-2026-08-31/tinydraw/DEVELOPING.md:158`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:13`, `puck-esp32s3-export-2026-08-31/tinydraw/tools/classify-tearing.py:49`, `puck-esp32s3-export-2026-08-31/tinydraw/esp32/dependencies.lock:12`

**Why it matters.** Display bugs often hide in odd widths, byte order, negative clipping, rotated coordinates, alpha/premultiplication, and final partial rows.

**Recommended change.** Define canonical internal pixel format and conversion boundaries. Add generated patterns and random rectangles across all orientations, strides, and edge coordinates.

**Acceptance evidence.** Reference hashes and pixel probes match software rendering and captured hardware; out-of-range geometry is rejected before memory access.

**Suggested owner.** Display / testing

#### F-073 — Keep unsupported controller behavior explicit rather than plausible [P3]

**Positive foundation.** The roadmap’s candid unknowns are a strong habit to preserve.

**Evidence.** TODO/unimplemented references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:77`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:78`, `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0002-runtime-architecture.md:366`, `puck-esp32s3-export-2026-08-31/puck/packs/esp32-s3-touch-amoled-18/docs/decisions/README.md:8`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:253`

**Why it matters.** Returning zero, success, or a fabricated status for unknown commands can let firmware proceed into misleading state and make later debugging much harder.

**Recommended change.** In strict mode, trace and fail on unsupported operations; in compatibility mode, log a stable warning with call count and source. Never silently claim support.

**Acceptance evidence.** Support reports list every exercised unsupported operation; a release target has none in its required fixtures.

**Suggested owner.** Peripheral architecture

### Code quality & maintainability

#### F-074 — Remove panic/unchecked assumptions from untrusted-input paths [P1]

**Positive foundation.** Rust and TypeScript make explicit error handling practical.

**Evidence.** Potential panic/unsafe sites appear at `puck-esp32s3-export-2026-08-31/puck/packs/rp2350-touch-amoled-18/docs/decisions/0005-rca-core1-dies-on-first-button.md:80`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:98`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:104`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:105`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:106`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:107`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:112`, `puck-esp32s3-export-2026-08-31/esp32sim/cli-c3/src/main.rs:115`

**Why it matters.** An `unwrap`, assertion, unchecked index, or panic reachable from firmware, packet, manifest, or file input turns a guest fault into a host-process denial of service.

**Recommended change.** Classify call sites by trust, replace reachable panics with typed errors, add bounds checks before indexing, and reserve assertions for internal invariants proven by validated types.

**Acceptance evidence.** A panic hook test runs hostile corpora and observes zero host panics; remaining panics are documented unreachable invariants with tests.

**Suggested owner.** Runtime / upstream fork

#### F-075 — Reduce duplicated host logic by extracting validated domain types [P2]

**Positive foundation.** The live validator already contains the seeds of reusable domain types.

**Evidence.** Validation/framebuffer/headless references appear at `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:95`, `puck-esp32s3-export-2026-08-31/puck/src/abiGuard.ts:124`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:20`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:49`, `puck-esp32s3-export-2026-08-31/puck/src/panel.ts:55`, `puck-esp32s3-export-2026-08-31/puck/site/dist/emu/main.js:28`

**Why it matters.** Passing primitive tuples and raw pointers between layers invites repeated checks, inconsistent units, and accidental bypass.

**Recommended change.** Introduce constructors for validated guest ranges, framebuffer descriptors, pixel bands, log chunks, event timestamps, and artifact IDs; make invalid states unrepresentable.

**Acceptance evidence.** Raw guest numeric fields are confined to the ABI module; downstream code accepts only validated types.

**Suggested owner.** Architecture / runtime

#### F-076 — Put explicit size and numeric conversion helpers in one module [P2]

**Positive foundation.** Central helpers can make the existing hardening concise rather than repetitive.

**Evidence.** Numeric pointer/length and MAX references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/speed-plan.md:70`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:182`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32c3/src/machine.rs:42`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32c3/src/machine.rs:56`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32c3/src/machine.rs:183`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32c3/src/machine.rs:187`

**Why it matters.** JavaScript number coercion, signed/unsigned conversion, multiplication overflow, and Rust `usize` conversion differ across 32/64-bit and Wasm/native environments.

**Recommended change.** Use checked helpers for guest `u32/u64`, add/multiply/range, `usize` conversion, dimensions, and byte counts. Reject NaN, infinities, fractional values, negatives, and wraparound.

**Acceptance evidence.** Cross-language boundary vectors produce the same accept/reject decision and error code.

**Suggested owner.** Runtime

#### F-077 — Separate debug instrumentation from correctness semantics [P2]

**Positive foundation.** Tracing and visualization are valuable for reverse engineering and agent productivity.

**Evidence.** Trace/debug and Bus/JIT references appear at `puck-esp32s3-export-2026-08-31/MANIFEST.md:31`, `puck-esp32s3-export-2026-08-31/puck/README.md:30`, `puck-esp32s3-export-2026-08-31/puck/README.md:66`, `puck-esp32s3-export-2026-08-31/puck/README.md:169`, `puck-esp32s3-export-2026-08-31/puck/README.md:282`

**Why it matters.** Instrumentation that changes scheduling, memory path, allocations, or device flush cadence can make the observed bug disappear or produce a different machine.

**Recommended change.** Define zero-semantic-effect event taps; test tracing on/off equivalence; document any mode that intentionally disables optimization and compare it with the oracle.

**Acceptance evidence.** The same deterministic workload has identical semantic hashes with logging/tracing enabled and disabled, excluding the trace artifact itself.

**Suggested owner.** Architecture / debugging

#### F-078 — Bound caches and make invalidation observable [P2]

**Positive foundation.** ESP32Sim’s TLB/block/JIT caches are an effective performance strategy.

**Evidence.** Fast-memory and cache-adjacent references appear at `puck-esp32s3-export-2026-08-31/esp32sim/docs/decisions.md:200`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/architecture.md:72`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:143`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/block.rs:187`, `puck-esp32s3-export-2026-08-31/esp32sim/xtensa-lx7/src/bus.rs:59`, `puck-esp32s3-export-2026-08-31/esp32sim/esp32s3/src/bus.rs:622`

**Why it matters.** Unbounded or stale caches can consume memory, execute code after remap/self-modification, or make failures workload-order dependent.

**Recommended change.** Set capacities, expose hit/miss/eviction/invalidation counters, centralize mapping version changes, and stress self-modifying code, flash remap, reset, and long-running workloads.

**Acceptance evidence.** Cache memory plateaus under adversarial address streams and interpreter/JIT outputs remain identical after every invalidation case.

**Suggested owner.** CPU / performance

#### F-079 — Use structured logging with stable event IDs [P2]

**Positive foundation.** The project produces rich evidence and diagnostic output.

**Evidence.** Serial/log transport references appear at `puck-esp32s3-export-2026-08-31/tinydraw/puck/README.md:25`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:7`, `puck-esp32s3-export-2026-08-31/tinydraw/puck/src/wasi_support.cpp:14`, `puck-esp32s3-export-2026-08-31/puck/docs/abi.md:244`, `puck-esp32s3-export-2026-08-31/puck/src/wasm.ts:216`

**Why it matters.** Free-form logs are hard for agents and CI to compare; wording changes can break tests while important warnings are missed.

**Recommended change.** Emit structured internal events with stable IDs and fields, then render human-readable text at the edge. Keep guest serial bytes distinct from host diagnostics.

**Acceptance evidence.** Tests assert event IDs/fields; text localization or wording changes do not alter semantic results.

**Suggested owner.** Runtime / observability

#### F-080 — Add ownership maps and module-level invariants to complex files [P3]

**Positive foundation.** The architecture documentation is already a strong onboarding asset.

**Evidence.** Architecture/roadmap documentation appears at `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/esp32sim/docs/roadmap.md:11`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:1`, `puck-esp32s3-export-2026-08-31/puck/docs/roadmap.md:61`

**Why it matters.** High-velocity emulator code can become difficult for multiple agents to change safely when invariants live only in commit messages.

**Recommended change.** For scheduler, memory map, JIT, WASI host, registry, display DMA, and replay modules, add concise invariant comments, state diagrams, and CODEOWNERS entries.

**Acceptance evidence.** Every high-risk module names its invariants, trusted inputs, owner, and required tests; agent PR templates link to them.

**Suggested owner.** Project lead / documentation

## Recommended architecture contract

The Puck-owned backend interface should be deliberately smaller than ESP32Sim. A practical first contract is:
- `create(config, services) -> Backend` where config is validated, versioned, and contains only deterministic board/chip inputs.
- `load(artifact_set)` with immutable, hashed firmware/ROM/partition inputs and bounded sizes.
- `reset(kind)` with explicit power-on/software/watchdog semantics.
- `run_until(virtual_deadline, budget) -> RunSlice` where budget includes cycles/instructions, wall time, memory, and event limits.
- `inject(event)` for timestamped touch/GPIO/serial/network-transcript events.
- `drain_events(max)` returning only typed, bounded events—never guest pointers.
- `inspect(range, max_bytes)` as an explicitly privileged debugging operation, disabled or constrained in untrusted modes.
- `capabilities()` with backend/version/JIT/network/snapshot/board support.
- `snapshot()` only after a complete versioned state design; otherwise report unsupported.
- `close()` with deterministic cleanup and no remaining Workers, sockets, timers, or executable mappings.

The adapter must own virtual time, event schema, quotas, and error codes. ESP32Sim can implement those contracts, but Puck should not depend on `Bus`, TLB entries, JIT blocks, peripheral structs, or CLI/web internals.

## Revised roadmap

### Gate 0 — Freeze and authorize the foundation

**Suggested timing:** Now; 1–3 days

**Work:**
- Freeze this archive and record its hash, roots, commits, tool versions, and fixture inventory.
- Resolve ESP32Sim license/permission and asset redistribution status.
- Approve the trust model: firmware/modules/packs are untrusted; browser, headless runner, CI, local network, and filesystem are protected assets.
- Name the V2 CO5300/CST820 board as the first hardware acceptance target.

**Exit gate:**
- Written license/permission; signed provenance manifest; approved threat model; no unresolved P0 governance decision.

### Milestone 1 — Harden the Puck execution boundary

**Suggested timing:** First implementation milestone

**Work:**
- Extract one shared guest-memory/output validator used by live, headless, replay, and verifier paths.
- Harden WASI-lite imports and numeric conversions; add memory-view refresh and atomic output.
- Add memory/cycle/wall-time/log/frame/queue quotas and disposable Worker/process execution.
- Create hostile module, manifest, event, path, and log corpora.

**Exit gate:**
- All hostile cases fail with stable typed errors across every mode; no crash, hang, escape, unbounded allocation, or partial accepted artifact.

### Milestone 2 — Make CI the executable specification

**Suggested timing:** Immediately after Milestone 1

**Work:**
- Require typecheck/lint/unit/hostile/headless/browser/pack-registry jobs.
- Require Rust fmt/test/clippy plus non-skipping decoder corpora with case counts and hashes.
- Pin actions/toolchains/downloads; add clean-room reproducibility and fixture provenance.
- Add semantic golden assertions, timeout/leak checks, and branch-policy audit.

**Exit gate:**
- A deliberately injected defect in each boundary is caught by a required job; clean checkout reproduces documented artifacts.

### Milestone 3 — ESP32Sim adapter feasibility spike

**Suggested timing:** Before peripheral grafting

**Work:**
- Create a Puck-owned backend adapter with run-to-deadline and typed event APIs.
- Implement interpreter-only integration first; networking off; JIT off.
- Prove scheduler semantics and interpreter/JIT observation parity, including the fast-memory bypass case.
- Decide fork structure, upstream sync policy, capabilities, and adapter versioning.

**Exit gate:**
- Boot one minimal firmware deterministically; identical normalized events in repeated runs; adapter contract tests pass with fake and ESP32Sim backends; no Puck imports of upstream internals.

### Milestone 4 — V2 board boot/display/touch slice

**Suggested timing:** First user-visible hardware milestone

**Work:**
- Capture V2 reset, flash/PSRAM, CO5300, CST820, and DMA transactions.
- Implement board manifest, boot contract, display command path, banded DMA, touch transform, and TinyDraw scenes.
- Compare controller traces and visual/touch outputs with real hardware.

**Exit gate:**
- Known firmware boots; exact serial milestones; display semantic/pixel checks; scripted touch; bounded memory; no unsupported operations in strict mode.

### Milestone 5 — Local peripherals and developer UX

**Suggested timing:** After V2 vertical slice

**Work:**
- Add only peripherals demanded by selected firmware, one evidence-backed slice at a time.
- Stabilize replay manifests, structured events, diagnostics, snapshots only if complete, and browser/native capability reporting.
- Add scheduled hardware-in-the-loop runs.

**Exit gate:**
- Each peripheral has positive/boundary/fault tests and hardware evidence; browser/headless parity remains green.

### Milestone 6 — Optional performance and networking

**Suggested timing:** After correctness gates are stable

**Work:**
- Enable JIT only behind capability/trust flags and differential CI.
- Add deterministic network transcripts before opt-in policy-controlled NAT.
- Benchmark per host architecture; preserve quotas and observation hooks.

**Exit gate:**
- Interpreter/JIT semantic parity; protected-network tests; no boundary bypass; measured real-time targets on named hosts.

### Milestone 7 — Original board revision and release hardening

**Suggested timing:** Separate follow-on

**Work:**
- Acquire SH8601/FT3168 hardware and capture independent evidence.
- Add revision manifest and conformance rather than speculative shared branches.
- Produce SBOM, attestations, signed artifacts, security documentation, support matrix, and incident/update process.

**Exit gate:**
- Original revision passes its own hardware suite; release artifacts are licensed, reproducible, signed, and policy-audited.

## Agent execution plan

Parallel work becomes safe after ownership and interfaces are fixed. A useful split is:
- **Boundary agent:** shared validators, numeric/range helpers, WASI-lite hardening, quotas, and hostile corpus.
- **CI/evidence agent:** required workflow matrix, toolchain pinning, decoder artifacts, fixture manifests, and reproducibility.
- **Adapter agent:** Puck backend contract, fake backend, interpreter-first ESP32Sim implementation, capability/version negotiation.
- **Timing/CPU agent:** scheduler ADR, observation hooks, interpreter/JIT differential programs, cache/invalidation tests.
- **V2 board agent:** board manifest, reset/flash/PSRAM contract, CO5300/CST820 traces, display/touch vertical slice.
- **Security agent:** NAT/WebSocket/filesystem policies, unsafe-code inventory, fuzz targets, release threat model.
- **Integration agent:** owns mainline, cross-agent API decisions, golden review, and milestone exit evidence.

Each agent PR should state: invariant changed, trust boundary touched, exact tests added, fixtures changed, capability impact, rollback path, and whether upstream synchronization becomes harder. Architecture, ABI, timing, and golden changes should be reviewed by the integration agent before merge.

## Definition of done for the first credible beta

- ESP32Sim and every redistributed asset have explicit, recorded license/permission and provenance.
- All guest memory and output crosses one shared validated ABI in live, headless, replay, browser, and verifier modes.
- Untrusted execution is isolated and bounded by memory, cycle/instruction, wall-time, output, queue, and artifact quotas.
- Required CI runs strict typecheck/lint/unit/hostile/regression/browser/pack-registry and Rust fmt/test/clippy/decoder conformance with nonzero counts.
- The Puck-owned adapter is versioned and no product code outside it imports ESP32Sim internals.
- Interpreter is the semantic oracle; JIT is optional and differentially tested, including memory observation/accounting.
- V2 CO5300/CST820 boot, display, and touch are backed by exact firmware and hardware evidence.
- Goldens include semantic assertions and complete provenance, not only byte hashes.
- Networking is off by default for untrusted firmware and any live egress is explicitly consented, policy-limited, and rate-limited.
- Release artifacts have SBOM, notices, hashes, provenance attestation, signed manifest, capability/support matrix, and reproducible build instructions.

## Acceptance test matrix

| Boundary | Adversarial cases | Required result |
|---|---|---|
| Guest memory ABI | OOB, wraparound, stale view, memory growth, alignment | All modes return same typed error; bounded memory; no host panic |
| Runtime quotas | Infinite loop, frame/log/event floods, huge dimensions | Forced termination within budget; stable quota code; no partial pass |
| WASI-lite | Iovec count/length/pointer/UTF-8/closed fd | Correct errno or bounded output; property/mutation tests |
| Artifacts | Path traversal, symlink, disk-full, kill mid-write | Confined paths; atomic commit; previous goldens preserved |
| CPU semantics | Instruction families, exceptions, MMU, self-modifying code | Interpreter oracle; mandatory decoder corpus; JIT differential |
| Timing | Same-cycle IRQ/DMA/timer/reset/input | Documented tie-break order; repeatable event hash; hardware trace where available |
| Display | Odd stride, endian, clipping, rotation, final band | Pixel/semantic match; no OOB; bounded queue/memory |
| Touch | Transform, interrupt/latch, edge coordinates, multi-event | Scripted events match hardware/controller trace |
| Networking | No-network default, protected ranges, DNS rebind, quotas | No protected egress; explicit consent/allowlist; deterministic transcript mode |
| Browser parity | Worker lifecycle, memory growth, CSP/cache/reload | Production browser tests; same normalized result as headless |
| Provenance | Toolchain, source, firmware, fixture, license, SBOM | Reproducible manifest and signed release attestation |

## Sources and evidence references

- Supplied archive: `puck-esp32s3-export-2026-08-31-r2.zip`, SHA-256 `32dbbd6890be1787bcbe22fbb7d0f57003ec4d69d4013fbc6adad67de0c05db1`.
- Local Puck source root: `puck-esp32s3-export-2026-08-31/puck` in the supplied archive.
- Local ESP32Sim source root: `puck-esp32s3-export-2026-08-31/esp32sim` in the supplied archive.
- Public upstream repository checked for current metadata and head: `https://github.com/joakimeriksson/esp32sim`; reviewed public head `2114ffc92039b4605264d2cfb4ee5543acbf98c1` (2026-08-30).
- Public GitHub repository metadata at review time reported no declared license. The bundled snapshot is the authoritative code evidence for this review; public metadata is used only for provenance/maturity context.
- Companion artifacts: `puck-review-test-results.txt` and `puck-review-findings.json` preserve command outcomes and the machine-readable finding register.

## What not to do

- Do not start a deep merge or product fork of ESP32Sim until its repository-level license and the bundled asset rights are explicit in writing.
- Do not assume that wrapping ESP32Sim’s `Bus` trait observes every memory access; the JIT fast path bypasses it.
- Do not maintain separate validation logic for live canvas, headless replay, regression, and verification hosts.
- Do not dereference guest pointers, iovecs, dimensions, counts, or strings before checked range and quota validation.
- Do not trust cached typed-array views across guest calls that may grow WebAssembly memory.
- Do not run untrusted firmware in the same long-lived process that adjudicates or publishes test results.
- Do not enable native NAT or unrestricted host networking by default; never allow untrusted firmware implicit access to localhost, private networks, or metadata services.
- Do not expose a control WebSocket beyond loopback without explicit authentication, Origin validation, TLS, and size/rate limits.
- Do not let a required conformance test silently pass because its external corpus or firmware file is missing.
- Do not treat a golden image, WAV, trace, or serial transcript as proof of correctness by itself.
- Do not regenerate goldens in the same opaque step that changes behavior; require a semantic diff and provenance update.
- Do not target CO5300/CST820 and SH8601/FT3168 simultaneously; finish the evidence-backed V2 vertical slice first.
- Do not advertise original-revision support until that exact board has independent hardware traces and conformance results.
- Do not expose ESP32Sim internal machine, bus, JIT, or peripheral types throughout Puck; keep a Puck-owned adapter boundary.
- Do not make JIT availability a correctness requirement or enable it first in untrusted proof modes.
- Do not optimize past validators, quota accounting, memory hooks, cache invalidation, or exact timing checks.
- Do not silently return plausible zeros or success for unsupported registers, commands, or peripheral states in strict mode.
- Do not allow guest or manifest names to become filesystem paths, cache keys, DOM HTML, or shell arguments without canonicalization.
- Do not run arbitrary install/build scripts in trusted developer or release environments without isolation and a reviewed allowlist.
- Do not pin GitHub Actions, toolchains, ROMs, or archives only by mutable tag/URL; verify immutable commits and digests.
- Do not publish firmware, ROMs, SDK-derived binaries, media, or calibration assets until their redistribution status is recorded.
- Do not let agents update architecture, ABI, timing, fixtures, and upstream pins in one unreviewable change; split decisions and preserve rollback points.
- Do not interpret the upstream project’s rapid progress as a stable maintenance or compatibility guarantee; own the fork and its tests.
- Do not claim cross-platform performance from Apple Silicon JIT measurements; report backend, host, workload, and semantic mode.
- Do not call the project release-ready until the security boundary, required CI matrix, provenance, and hardware acceptance gates are all enforced.
