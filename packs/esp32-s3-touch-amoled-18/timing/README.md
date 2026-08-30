# ESP32-S3 timing scheduler

`model.ts` is a deterministic shadow scheduler for one CPU producer and one
panel DMA consumer. It keeps their clock rates separate, allows at most three
outstanding panel transfers, and records production, queue waits, submits,
DMA starts, and completions on an exact rational timeline. Each event reports
the queue occupancy after that event.

`scheduleTransfer()` accepts a byte count, maximum strip size, and linear cycle
models for both resources. Fractional per-byte costs round up once per strip. A
partial final strip is retained. Queue depth counts the active DMA transfer plus
queued transfers. Events at the same timestamp use a fixed semantic order, so
repeated inputs produce the same event sequence.

Every result carries a calibration verdict and names each uncalibrated input.
The scheduler does not turn configured clocks or estimated cycle costs into a
latency claim. Host trace time is not an input to this timeline.

Run the executable acceptance tests from the repository root:

```sh
bun test packs/esp32-s3-touch-amoled-18/timing/model.test.ts
```
