# Lane C: contention, interrupts, and cycle correlation

Home: esp32sim fork, `lane-c/*` off `puck/base`. Blocked by lane B's
adapter and measured-mode core; starts when B's spike spec is accepted.

Read first: decisions 0008 and 0012; roadmap lane C row; the contended
receipt cohorts under
`packs/esp32-s3-touch-amoled-18/timing/evidence/` (`*_core1_contended`
cells); decision 0007's original blocker list for historical context.

Scope: measured-mode dual-core interleaving quanta and their tie-break
rules (documented as an ADR per review F-033/036, with deterministic
trace events for core step, IRQ assert/accept, device deadline); MSPI
arbitration between cores and DMA; interrupt delivery timing anchored to
the measured 228/142 (level 1) and 223/138 (level 3) dispatcher costs;
race-sensitive litmus firmware. Correlate modeled contention against the
contended receipt cohorts; new probe requests go through the board owner
(lane E).

Out of scope: arbitration guesses adopted without receipts (interval or
distribution tiers are available when the policy cannot be identified
exactly); JIT.

Exit: contended-cohort correlation within decision-0008 bounds; the
scheduler ADR merged; litmus suite green and deterministic.
