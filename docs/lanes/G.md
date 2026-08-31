# Lane G: CI as the executable specification

Home: puck workflows and the esp32sim fork's workflows. Cloud-viable,
independent, start immediately.

Read first: roadmap lane G row; review findings F-047, F-048, F-052,
F-053, F-054 and their dispositions in
[`../reviews/2026-08-31-external/RESPONSE.md`](../reviews/2026-08-31-external/RESPONSE.md).

Scope, puck side: required jobs for strict typecheck, unit tests, hostile
modules, headless regression, browser smoke, pack/registry validation.
Scope, fork side: Rust fmt/test/clippy; decoder conformance made
fail-closed with a small committed mandatory corpus, executed case counts
and corpus hashes printed (a missing corpus is an error, never a skip).
Both sides: pin actions by commit SHA, verify downloaded artifacts by
digest, make the intended environment explicit (the external review's
harness ran without bun or cargo and appended a Jest flag to tsc; CI must
be immune to that class of confusion).

Golden discipline: semantic assertions and provenance sidecars accompany
fixtures; golden updates require a semantic diff.

Exit: a deliberately injected defect in each boundary fails its required
job; a clean checkout reproduces documented artifacts; conformance case
counts are visible in required logs.
