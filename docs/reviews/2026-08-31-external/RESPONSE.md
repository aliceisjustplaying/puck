# Response to the external adversarial review of 2026-08-31

The review (80 findings: 6 P0, 26 P1, 40 P2, 8 P3, in this directory)
examined export archive r2 (SHA-256 `32dbbd68...`). This response records
the maintainer's dispositions so restarted lanes inherit them.

## Correction to the review's verification snapshot

All four "fail" rows in the review's command table are review-environment
artifacts, not repository defects: the reviewer's harness had no `bun` and
no `cargo` installed (its own tool probe says so), and it appended
`--runInBand`, a Jest flag, to every npm script, producing
`tsc --noEmit --runInBand` and the TS5023 error it then reported. The
repository's typecheck and test suites pass locally throughout the session
history. The architectural conclusion the review draws from this (required
CI must make the environment explicit) is accepted; the implied defect is
not.

## Dispositions

### Resolved by maintainer decision

- **F-001 (licensing, P0):** esp32sim's README declares MIT twice and
  every crate declares `license = "MIT"` through the workspace manifest.
  The maintainer accepts this in-repository declaration as the licensing
  basis; the author will be asked to add the root LICENSE file. Recorded
  in decision 0011.

### Accepted, change the plan

- **F-031 (JIT bypasses `Bus`, P0):** confirmed against code
  (`xtensa-lx7/src/block.rs:143,187`, `esp32s3/src/bus.rs:622`); this
  sharpens the caveat already in decision 0011. Measured mode is
  interpreter-first, and its observation contract is defined at the CPU
  backend level, never as a `Bus` wrapper alone. A cross-mode conformance
  program (RAM, flash, MMIO, faults, self-modifying, cross-page) becomes a
  lane B exit criterion.
- **F-048 (fail-open decoder conformance, P0):** accepted; also honestly
  qualifies upstream's "977k, 0 mismatches" as a local, not CI-enforced,
  claim. The fork's CI makes corpus absence an error and commits a small
  mandatory corpus.
- **F-047, F-052, F-053, F-054 (CI matrix, browser tests, semantic golden
  review, fixture provenance):** accepted as a new CI lane.
- **F-011, F-012, F-013, F-014, F-074 (shared validator, WASI hardening,
  quotas, view refresh, panic-free untrusted paths):** accepted as a
  boundary lane, scoped by the trust model in decision 0012: the public
  gallery and external-bundle paths are the hardening targets; local runs
  of the developer's own firmware are not the threat.
- **F-032, F-033, F-034 (adapter boundary, scheduler ADR,
  interpreter-as-oracle):** accepted into lane B; the review's
  "Recommended architecture contract" section is adopted as the starting
  sketch for the adapter interface.
- **F-017 (networking off by default):** accepted as a standing rule.
- **F-066 (capture controller transactions before modeling), F-064/F-065
  (V2-first, SH8601 experimental):** accepted; lane A was already scoped
  to the maintainer's board revision, and gains a capture-first step.
- **F-002, F-046 (provenance record, clean patch stack):** accepted; the
  fork ships with `PROVENANCE.md` from day one.

### Deferred to the release gate, deliberately

SBOM and attestations (F-061), secret scanning (F-008), CSP and isolation
headers (F-026), branch-protection audits (F-051), capability matrices
(F-039), performance-claim governance (F-045, F-063), and the wider
release-engineering battery are real requirements for a public,
multi-user release and premature for a research-phase tool with one
public surface. They are queued at lane F (integration and ship), not
before, and the review's "Definition of done for the first credible
beta" is adopted as that lane's checklist.

### Rejected in part

- **"Pause deep ESP32Sim implementation until the foundation gate is
  complete":** the strong form is declined. The licensing gate is
  resolved, and the review's own Milestone 3 (interpreter-only,
  networking-off adapter spike) is precisely the safe exploration
  vehicle; serializing weeks of boundary and CI work ahead of it would
  cost calendar time without reducing the risks those milestones address.
  The compressed Gate 0 (license recorded, provenance on fork, trust
  model ADR, V2-first) is completed instead, and the boundary and CI
  lanes run in parallel with the adapter spike.
