# Lane E: silicon oracle operations (board-owner lane)

Home: tinydraw (probe projects, capture tooling) and the esp32sim fork's
`hw/` scripts. This lane owns the physical board; other lanes file
requests here. Hardware-serialized by nature; a second board, when
present, serves this queue first.

Read first: roadmap lane E row; decision 0008;
`tinydraw/calibration/esp32s3-core-timing/README.md` and
`esp32s3-memory-timing/` (methods and results); upstream `hw/difftest.sh`
and `hw/compare.py` (the JTAG lock-step method).

Scope: run upstream's JTAG lock-step against this project's board (efuse,
strap, reset-state adoption included; this also produces lane A's chip
identity); extend the comparison with CCOUNT deltas once lane B's
measured mode exists; remaining probe families: arbitration
discrimination, PSRAM long-window distributions, cache store and
writeback classes; service capture requests from lanes A and C.

Rules: every capture becomes a committed, hash-pinned receipt in the
established format; two-boot cohorts for anything adopted; the board is
never reflashed while another lane's request is mid-capture.

Exit: this lane does not exit; it operates. Milestones: lock-step green
on our board; identity bundle delivered to lane A; each probe family's
cohort committed and dispositioned into a decision-0008 tier.
