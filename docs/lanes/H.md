# Lane H: boundary hardening

Home: puck. Cloud-viable, independent, start immediately. Scoped strictly
by decision 0012's trust model: the public gallery and external-bundle
paths get the armor; local runs of the developer's own firmware get
correctness checks, not sandboxing theater.

Read first: decision 0012; review findings F-011 through F-014 and F-074
with dispositions; `docs/findings-first-adversarial-pass.md` (the
original tick-loop findings, same spirit); `src/abiGuard.ts` and
`src/wasiLite.ts` (the existing partial armor to unify, not rebuild).

Scope: one shared guest-output validator used by live, headless, replay,
and verifier paths (validated value objects, never raw guest pointers);
WASI-lite hardening (checked u64 arithmetic, iovec caps, bounded UTF-8,
deterministic clock/random, explicit errno); per-run quotas rejected
before allocation; typed-array view refresh after memory growth;
panic-free untrusted paths with typed errors. Grow the hostile corpus to
cover each new check.

Exit: the hostile corpus produces the same typed failure in every host
mode with no crash, hang, allocation spike, or partial artifact; raw
guest numerics are confined to the ABI module.
