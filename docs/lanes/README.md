# Lane briefs

One file per roadmap lane. The complete handoff to an implementing agent
is: a checkout of this repository (branch `codex/esp32s3-timing-model`),
one lane letter, and the instruction to read that lane's brief and
everything it links before writing code.

Read order for every lane: [`../roadmap.md`](../roadmap.md) (revision 3),
then the decisions it cites (0008 through 0012), then your brief.

## Repositories

- **puck** (this repo): `aliceisjustplaying/puck`, branch
  `codex/esp32s3-timing-model`. Docs, decisions, timing lab and receipts,
  harness, packs, experiments.
- **esp32sim fork**: `aliceisjustplaying/esp32sim`. `main` is a clean
  upstream mirror, never committed to. `puck/base` is the pinned base
  (`2114ffc`) plus fork-carried commits; see its `PROVENANCE.md` for the
  branch conventions. Lane work branches: `lane-<letter>/<topic>`, from
  `puck/base`, or from `main` when the work is an upstream-shaped pull
  request.
- **tinydraw**: `aliceisjustplaying/tinydraw`. Calibration probe projects
  and capture tooling only.

## Rules that bind every lane

- Every measured or adopted number carries a receipt (file path or
  committed evidence); refusals name their decision-0008 tier candidate.
- The physical board has one owner at a time. Lanes that need hardware
  file a request with the maintainer; they do not open the serial port or
  JTAG opportunistically.
- Fail closed: unknown costs stay unknown, missing corpora fail tests,
  unsupported operations are refused, never faked.
- Upstream-first for esp32sim changes upstream would want; the fork
  carries only what upstream declines.
- No em dashes in this repository's files. TypeScript for puck tooling,
  Rust for the emulator, C only for firmware.
- Stop and report at your exit criteria, on any blocked decision, or when
  a finding contradicts a decision record. Do not start another lane's
  work.
- Update `experiments/esp32s3-flexe-wasm/STATUS.md` when your lane
  reaches a milestone or hands off.

## Lanes

| Lane | Brief | Home |
| --- | --- | --- |
| 0 | [0.md](0.md) | tinydraw + puck (LOCAL ONLY, needs the board) |
| A | [A.md](A.md) | esp32sim fork |
| B | [B.md](B.md) | esp32sim fork |
| C | [C.md](C.md) | esp32sim fork |
| D | [D.md](D.md) | esp32sim fork (upstream-shaped) |
| E | [E.md](E.md) | tinydraw + esp32sim fork (board-owner lane) |
| F | [F.md](F.md) | puck |
| G | [G.md](G.md) | puck + esp32sim fork |
| H | [H.md](H.md) | puck |
