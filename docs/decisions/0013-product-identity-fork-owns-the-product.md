# 0013: Product identity, the fork owns the product

Date: 2026-08-31
Status: accepted
Amends: 0011 (the role of puck), 0012 (adapter ownership)

## Context

This effort started inside puck as a device pack and timing lab, then
found esp32sim already implementing most of the execution engine
(decision 0011). Lane B's design spike asked the maintainer to state the
product's identity precisely, because "one Puck-owned adapter" in
decision 0012 no longer described the intended shape. The maintainer's
direction, recorded here in her own framing: the goal is a web-based,
wasm-based cycle-accurate emulator that happened to start in puck and
then happened upon esp32sim. TypeScript work is to be minimized.

## Decision

The product is a browser-hosted cycle-accurate ESP32-S3 emulator built
from our esp32sim fork. The fork owns the Rust machine, measured mode,
the versioned backend adapter, the WebAssembly bridge, device models,
safety seams, and the thin web UI shell with its TypeScript transport.

Puck is the donor, evidence, and decision repository: its UI, recorder
and replay, differential harness, timing model, receipts, and browser
pieces may be ported selectively with provenance. Puck does not carry an
execution engine or a second substantial adapter implementation, and no
TypeScript execution engine is ever built. The existing TypeScript
timing machine serves exactly one more purpose: a one-shot differential
gate against measured mode on shared traces (decision 0014), archived as
a receipt, then retired.

Cross-lane architectural decisions remain recorded here in puck's
`docs/decisions`, which stays the decision journal and evidence archive.

Product scope is the complete ESP32-S3 SoC plus the exact Waveshare
ESP32-S3-Touch-AMOLED-1.8 board at the maintainer's revision: SRAM,
flash, octal PSRAM, caches and MMU, DMA and peripherals, and eventually
the CO5300-class panel with GRAM, TE and scan-out, the board's touch
controller (named by lane A's capture, not before), QMI8658, PCF85063A,
and TCA9554. Radio and SoC blocks omitted from the first milestone are
deferred, not excluded. The first useful milestone is real TinyDraw
firmware boot, draw, and touch in the browser.

## Consequences

Decisions 0011 and 0012 carry amendment notes pointing here. Roadmap
revision 4 restates lane B and lane F against this identity. The fork's
`docs/` may carry engineering documents, but numbered decisions and
receipts live in puck.
