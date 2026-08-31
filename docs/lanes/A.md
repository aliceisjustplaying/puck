# Lane A: exact-board fidelity on esp32sim

Home: esp32sim fork, `lane-a/*` off `puck/base`. Pieces upstream will
want (device models useful to other boards) split into `main`-based PR
branches.

Read first: roadmap lane A row; decision 0011;
[`../../experiments/esp32sim-adoption/README.md`](../../experiments/esp32sim-adoption/README.md)
(the boot baseline and the exact gap list); review findings F-064/065/066
dispositions in
[`../reviews/2026-08-31-external/RESPONSE.md`](../reviews/2026-08-31-external/RESPONSE.md).

Scope: a `BoardModel` for the Waveshare ESP32-S3-Touch-AMOLED-1.8 at the
maintainer's revision exactly: CO5300-class QSPI panel device (GRAM, TE
timing, scan-out position), CST816S-family touch as an I2C device,
QMI8658, PCF85063A, TCA9554 wiring (device model exists upstream). The
GP-SPI2 master is already modeled; do not rebuild it. Capture-first
(F-066): obtain the real panel and touch transactions before modeling;
file a board request with the maintainer for captures. Chip identity
(efuses, strap, MAC) is adopted from the physical board via upstream's
JTAG flow, board-owner assisted.

Known contracts to satisfy: the firmware's own
`te_edge=rising clock_mhz=40` line; the pack's measured 40 MHz receipts;
tinydraw's tearing classifiers as acceptance tooling.

Out of scope: timing/measured mode, radio, battery analog, the other
board revision (interfaces ready, no speculative branches).

Exit: the TinyDraw gate-harness image boots with the panel drawing and
scripted touch working; `TINYDRAW_LIVE_FAIL` reports presenter=1 touch=1;
visual and TE acceptance against hardware captures recorded as receipts.
