# Decision records

`packs/esp32-s3-touch-amoled-18/AGENTS.md` says how this pack is built. Its
`README.md` says what it is. These say **why**.

| | |
|---|---|
| [0001](0001-what-the-first-flash-found.md) | What an unflashed firmware half was actually worth: two unimplemented platform hooks, an unpowered panel, and a clock rate nobody had measured. Also what the inheritance got right. |
| [0002](0002-devlink-over-usb-serial-jtag.md) | The transport for driving this board from the differential harness: the sibling pack's protocol, unchanged, on the chip's own USB Serial/JTAG port, with screenshots captured at flush time because there is no framebuffer to walk. |

The sibling pack's own records
([`../../../rp2350-touch-amoled-18/docs/decisions/`](../../../rp2350-touch-amoled-18/docs/decisions/))
cover the runtime architecture and the emulator seam these two build on, and
are worth reading first if you have not.
