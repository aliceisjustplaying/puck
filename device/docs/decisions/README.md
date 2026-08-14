# Decision records

`device/AGENTS.md` says how the firmware is built. The README says what it is.
These say **why**, and they are the part of this repo most worth reading if you
are not going to flash anything: each one is a real problem, what was tried,
what the evidence actually said, and what was decided.

| | |
|---|---|
| [0001](0001-push-min-width.md) | Every pushed window's row length must be a multiple of 8 pixels. Days of bisection, because a corrupt partial refresh looks exactly like a touch bug. |
| [0002](0002-runtime-architecture.md) | One binary, all apps, switching is a function call. Why the earlier reboot-into-another-flash-slot design lost. |
| [0003](0003-emulator-runs-the-real-apps.md) | The emulator runs the firmware's own C compiled to WebAssembly, never a reimplementation. |
| [0004](0004-the-day-the-instruments-lied.md) | A day spent chasing a bug in which every measurement was wrong in a different way. The longest and, if you read one, the one. |
| [0005](0005-rca-core1-dies-on-first-button.md) | Root cause of that bug: core0 borrows the flash chip select to read BOOT, and core1 was fetching from that same flash. |
| [0006](0006-invariant-checker.md) | A static checker over the linked image, wired into the build, so 0005's hazard cannot come back quietly. |
| [0007](0007-core1-panic-is-already-lost.md) | Why a panic on core1 cannot report itself, and what is done instead. |
| [0008](0008-the-emulator-seam-is-in-the-wrong-place.md) | Where the line between "firmware" and "emulator" should actually fall. |
| [0009](0009-nothing-is-drawn-with-a-ruler.md) | No hard edges, no straight lines, no right angles. The visual rule the whole UI obeys. |

## Two notes for reading them

**They were written before this repo existed.** The firmware lived in a private
monorepo, and these records were written there as the work happened. They were
not rewritten for publication, because rewriting them into a tidy retrospective
would remove the only thing that makes them useful: they were written without
knowing how it turned out.

**So `puck` means different things in different records.** In 0006 it names a
plan to extract the emulator into its own repository. That extraction happened,
and this is that repository, with the firmware now living alongside it under
`device/`. Where an older record says "when `puck` exists", it exists; you are
in it.

A handful of paths pointing at files that stayed private have been reworded,
and nothing else has been touched. The same applies to the firmware's own
source comments, which still name monorepo paths in a few places; see
[`../../AGENTS.md`](../../AGENTS.md)'s first section.
