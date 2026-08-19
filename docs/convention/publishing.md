# Publishing

Listing is a reproduction, not a submission. Nothing about a port, a pixel-exact match, an invariant holding, a run on real silicon, is ever taken on prose. It is listed once `bun run verify-bundle <bundle>` rebuilds the module from its own declared source and replays its declared traces itself, and exits 0. A README can explain a port for a human reader; `bundle.json` is what the verifier reads, and it must be self-sufficient.

This document is the human-readable version of that flow and the responsibility model behind it. [`skills/puck-publish/SKILL.md`](../../skills/puck-publish/SKILL.md) is the same flow written for an agent to follow step by step; read that one when actually doing the work.

## The flow

1. Read the target pack's `AGENTS.md`, `device.json`, and `gotchas.md` before writing any code.
2. Extract a three-section descriptor (`Essence`, `Interactions`, `Demands`) from the app, and give a verdict against the pack: `go`, `degraded`, or `refuse`.
3. Record traces live in the emulator page, and confirm each one replays deterministically before trusting it.
4. Prove the port: pixel-exact frame diffs for a `faithful` port (`bun run portdiff ... --write-frames`), or invariants for an `adaptation` (`bun run invariants`), every invariant checked red-before-green by deliberately breaking what it should catch.
5. Assemble `bundle.json` against schema v0.2 (see [`app-bundle.md`](app-bundle.md)).
6. Run `bun run verify-bundle <bundle>` until it exits 0.
7. Publish: an `apps/` PR for an in-repo bundle, or the author's own repository plus a one-line `registry.json` PR for an external one.

## The responsibility model

**Authors prove their own claims.** Writing a `faithful` or `adaptation` port, choosing capture points, and stating invariants are the author's job; nothing in this repository invents a claim on an author's behalf. An invariant that the author cannot make fail by deliberately breaking the build is not a real check and does not get published, no matter how plausible it reads.

**CI re-verifies on every PR, push, and nightly**, from scratch, with no state carried from whoever opened the PR. `.github/workflows/verify-bundles.yml` runs `verify-bundle` over every entry in `registry.json` and fails the job if any port fails. This is the same command a publisher already ran locally; CI is not a second, different check, it is the same one, running unattended and without trusting the author's own machine.

**Instruments and packs have named owners.** The shared instrument (`src/`, `harness/`, `wasm/`) is device-agnostic and owned as a whole. Each device pack is a self-contained folder with its own `AGENTS.md`; whoever maintains a pack is responsible for that pack's own firmware, gotchas, and build script staying correct, not for every app ever ported to it.

**A silicon mark is an attestation, not an automatic guarantee.** `bundle.json`'s optional `silicon` field on a port records a dated claim that a named run happened against real hardware, citable back to a commit (see `apps/chrono/bundle.json`'s rp2350 port for the reference example, citing commit `f1958c3`). It is not re-run by CI on every push, because CI has no board attached; it is a statement someone made a real hardware run once, worth exactly as much as that citation checks out to, not a promise that today's `master` still behaves identically on that board. Emulator-proven and on-silicon are deliberately two different marks on the site's proof matrix for this reason: emulator-proven is reverified constantly, on-silicon is a point-in-time attestation.

**Verification failures are informative, not just gates.** A `FAIL` names the diverging frame or the failed invariant; an `ERROR` names a build or configuration problem. Treat either as something to fix at the source, not as a threshold to loosen until the run goes green.
