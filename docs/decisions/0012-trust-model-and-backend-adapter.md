# 0012: Trust model and the backend adapter contract

Date: 2026-08-31
Status: accepted

## Context

The external adversarial review of 2026-08-31
([`docs/reviews/2026-08-31-external/`](../reviews/2026-08-31-external/))
found that the project's security-relevant boundaries were implicit: the
live panel path validates guest output, but no written trust model says
which inputs are untrusted, which assets are protected, or where esp32sim
may be touched from. Its strongest technical finding (F-031) proved from
code that esp32sim's native JIT fast path bypasses the `Bus` trait
(`xtensa-lx7/src/block.rs:143,187`), so a timing or observation layer
wrapped around that trait alone would silently miss accesses.

## Trust model

Untrusted, always: firmware images and application binaries, WebAssembly
modules, packs, app bundles, external-bundle repositories (decision 0005's
trust statement stands: verifying one runs its build on this machine, by
explicit choice), recorded traces, and anything a browser visitor
uploads.

Protected assets: the visitor's browser session on the public gallery,
the developer's filesystem and network, CI verdicts and goldens, and the
receipts and evidence chain.

Scope gradient, so hardening lands where the exposure is: the public
gallery and any path that executes third-party material get the full
boundary treatment (shared validator, WASI hardening, quotas, memory-view
refresh, panic-free error paths). Local runs of the developer's own
firmware get correctness checks, not sandboxing theater.

Networking in the emulator defaults to none. Live egress is opt-in,
consented, and policy-limited; it is never available to gallery or
external-bundle execution.

## The backend adapter contract

All product code reaches esp32sim through one Puck-owned adapter; nothing
outside it imports upstream internals (machine, bus, peripheral, JIT, or
web types). The starting interface is the external review's recommended
contract: create with validated deterministic config, load with hashed
immutable artifacts, reset with explicit cause, run-to-deadline with
budgets, event injection, typed bounded event draining, privileged and
capability-gated memory inspection, capability reporting, versioning, and
deterministic shutdown. The adapter owns virtual time, the event schema,
quotas, and error codes.

Observation contract, per F-031: measured mode and any tracing define
their observation at the CPU backend level. The interpreter is the
semantic oracle and is mandatory in every environment; the JIT is an
optimization whose enablement is capability- and trust-gated, and whose
observations must be proven equivalent to the interpreter's by a
cross-mode conformance program (RAM, flash, MMIO, faults, self-modifying
code, cross-page access) before any measured-mode claim rides on it.

## Consequences

Lane B builds the adapter and the observation contract before peripheral
grafting. The boundary and CI lanes implement the accepted review
findings under this model's scoping. Release-gate items deferred by the
review response are checked against this decision when lane F opens.
