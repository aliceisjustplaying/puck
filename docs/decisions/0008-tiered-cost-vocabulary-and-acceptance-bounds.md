# 0008: A tiered cost vocabulary and workload-tiered acceptance bounds

Date: 2026-08-31
Status: accepted

## Context

Decisions 0006 and 0007 made every timing cost either an exact known scalar
or an explicit unknown. That refusal-by-default discipline prevented guessed
cycles, but the hardware evidence now shows the vocabulary cannot describe
the machine being measured:

- RTC-domain reads have stable non-integer mean costs (median additive
  slopes 87.8096 to 87.9258 cycles per read across boots, retained under
  `packs/esp32-s3-touch-amoled-18/timing/evidence/rtc-boot-read-70cc31a/`).
  The cause is clock-domain crossing: the per-read cost depends on phase
  between the CPU and the slow clock, so it is physically a distribution.
- An EXTMEM write cost refused as "not integral" (`12280 / 4096`) later
  proved exactly affine: 3 cycles per access with a fixed -8 cycle loop
  intercept (`evidence/esp32s3-rev02-tinydraw-e8a9f0e-mmio-write-adoption.json`).
  The refusal label could not distinguish "wrong model shape" from
  "genuinely random".
- Short bounded windows are bit-repeatable across boots, including
  miss-dominated random PSRAM access (100 identical samples per cell in
  `evidence/receipts-bf169bc/`), while the long cold-PSRAM window varies by
  about 0.10 percent. Determinism is a property of the window, not of the
  machine as a whole.

## Decision

Cost claims carry one of five machine-readable tiers, each with provenance:

- `exact`: one integer, reproduced across at least two clean boots.
- `affine`: an integer slope plus a fixed intercept, both evidenced, with
  the measured cell sizes that establish them.
- `interval`: bounded between two evidenced values, cause understood and
  stated.
- `distribution`: declared quantiles (at minimum min, median, max over a
  stated sample count and boot count), cause understood and stated, for
  example clock-domain phase or long-window aggregation.
- `unexplained`: measured variance nobody has diagnosed. Never adopted into
  a model result; always a work item.

A refusal must state its tier candidate. "Not an integer" alone is no
longer a terminal verdict: the affine and distribution tiers exist so the
EXTMEM and RTC cases stop being indistinguishable.

Simulated clocks may model slow domains explicitly. Inside the model, phase
is then deterministic and replayable; against silicon, agreement for
distribution-tier costs is statistical, never per-sample.

## Acceptance bounds

"Cycle accurate" is redefined as a tiered claim with declared error bounds,
because whole-machine bit-exactness is falsified by the machine's own
cross-boot variance:

- SRAM-resident bounded kernels: exact, zero-cycle error, per the
  bit-repeatable receipts.
- Frame-scale workloads (a full render or staging pass): total modeled
  cycles within 1 percent of the silicon median, with 0.1 percent as the
  aspirational bound, measured over at least two boots.
- Paths crossing the RTC or analog domains, and long cold-memory windows:
  distribution-tier agreement (modeled quantiles overlap measured
  quantiles), never scalar equality.

A correlation suite that checks these bounds on representative workloads is
the release criterion decision 0007 called for. No result may quote a
tighter tier than its evidence.

## Consequences

`timing.json` and the timing machine's cost types grow tier fields; the
exact-or-unknown states map onto `exact` and `unexplained` unchanged, so
existing adoptions keep their meaning. The RTC cohort becomes adoptable as
a distribution instead of permanently blocked. Decision 0006's rule that a
report must expose unaccounted work is unchanged.
