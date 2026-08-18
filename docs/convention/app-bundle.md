# App bundles

An app is defined by its descriptor and traces, not by its source code. The descriptor records intent. The traces and expected frames make observable behavior checkable.

## Descriptor

Every descriptor has exactly three sections:

- `Essence`: what appears on screen, including layout and visual character.
- `Interactions`: every input and its result.
- `Demands`: separate checkable requirements from preferences.

[`apps/chrono/descriptor.md`](../../apps/chrono/descriptor.md) is the reference descriptor.

## Verification material

Traces record portable input and capture points. Expected frames record the proven output for a target pack. Together they let the shared harness replay behavior and compare results.

App bundles may live under this repository's `apps/` directory or in an author's own repository. Local apps use a `{"name","path"}` entry in `registry.json`. External apps use a `{"name","url"}` entry.

## Porting flow

1. Read the app descriptor and the target pack.
2. Compare `Demands` with `device.json` and give a verdict before writing code: `go`, `degraded`, or `refuse`, with the mismatch or fit stated plainly.
3. Write an idiomatic implementation for the target pack. The bundled reference source is evidence, not the definition of the app.
4. Replay the traces and verify the resulting frames or invariants.

## Port modes

`faithful` keeps the same interaction surface. Its traces replay verbatim, and verification uses pixel-exact frame diffs.

`adaptation` changes the interaction surface. Its traces must be translated, and verification uses stated behavioral invariants instead of pixel identity.

Regenerated code can drift from the original and from later ports. The harness is the mitigation, not a guarantee. See [the harness documentation](../harness.md) and [the two-compilers decision](../decisions/0002-two-compilers-not-one.md).
