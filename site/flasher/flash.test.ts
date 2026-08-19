// site/flasher/flash.test.ts: the parts of the buttonless reflash path
// that can be proven without a board.
//
// The round trip itself (control request lands, bootrom takes over, board
// re-enumerates as 2E8A:000F, PICOBOOT accepts the write) needs the real
// device and is checked at the bench. What is checkable here is everything
// that decides WHAT gets sent and to WHOM: which device the flasher thinks
// it is holding, which interface it picks off the descriptors, and the
// exact eight bytes of the SETUP packet. Those are the parts a refactor
// can silently break, and a wrong byte in a control transfer fails as a
// stall on somebody else's desk, days later.
import { describe, expect, test } from "bun:test";
import {
  PUCK_RUNNING_PRODUCT_ID,
  RESET_REQUEST_BOOTSEL,
  RP2040_BOOTSEL_PRODUCT_ID,
  RP2350_BOOTSEL_PRODUCT_ID,
  RPI_VENDOR_ID,
  buildBootselResetSetup,
  classifyDevice,
  deviceFilters,
  encodeSetupPacket,
  findResetInterface,
} from "./flash";

describe("classifyDevice", () => {
  test("2E8A:000F is an RP2350 BOOTSEL device", () => {
    expect(classifyDevice({ vendorId: 0x2e8a, productId: 0x000f })).toBe("bootsel-rp2350");
  });

  test("2E8A:0003 is an RP2040 BOOTSEL device (refused by name, not silently flashed)", () => {
    expect(classifyDevice({ vendorId: 0x2e8a, productId: 0x0003 })).toBe("bootsel-rp2040");
  });

  test("2E8A:0009 is a running puck (pico-sdk CDC, the id the firmware's own device descriptor carries)", () => {
    expect(classifyDevice({ vendorId: 0x2e8a, productId: 0x0009 })).toBe("running-puck");
  });

  test("the exported ids are the ones the table is built from", () => {
    expect(RPI_VENDOR_ID).toBe(0x2e8a);
    expect(RP2350_BOOTSEL_PRODUCT_ID).toBe(0x000f);
    expect(RP2040_BOOTSEL_PRODUCT_ID).toBe(0x0003);
    expect(PUCK_RUNNING_PRODUCT_ID).toBe(0x0009);
  });

  test("another vendor is unknown even at a product id we recognise", () => {
    expect(classifyDevice({ vendorId: 0x1209, productId: 0x000f })).toBe("unknown");
  });

  test("Raspberry Pi's own non-BOOTSEL, non-puck ids are unknown, not assumed flashable", () => {
    // 0x000a is pico-sdk's RP2040 CDC id, 0x0004 a Pico probe: both are
    // this vendor, neither is a device this flasher can do anything with.
    expect(classifyDevice({ vendorId: 0x2e8a, productId: 0x000a })).toBe("unknown");
    expect(classifyDevice({ vendorId: 0x2e8a, productId: 0x0004 })).toBe("unknown");
  });
});

describe("deviceFilters", () => {
  test("offers both BOOTSEL ids plus the running puck, all at Raspberry Pi's vendor id", () => {
    expect(deviceFilters()).toEqual([
      { vendorId: 0x2e8a, productId: 0x000f },
      { vendorId: 0x2e8a, productId: 0x0003 },
      { vendorId: 0x2e8a, productId: 0x0009 },
    ]);
  });

  test("every filter is a kind classifyDevice can name", () => {
    for (const f of deviceFilters()) {
      expect(classifyDevice({ vendorId: f.vendorId!, productId: f.productId! })).not.toBe("unknown");
    }
  });
});

describe("the reboot-to-BOOTSEL control transfer", () => {
  test("RESET_REQUEST_BOOTSEL is 0x01, per pico/usb_reset_interface.h", () => {
    expect(RESET_REQUEST_BOOTSEL).toBe(0x01);
  });

  test("setup fields: class request to the reset interface, wValue 0", () => {
    expect(buildBootselResetSetup(2)).toEqual({
      requestType: "class",
      recipient: "interface",
      request: 0x01,
      value: 0x0000,
      index: 2,
    });
  });

  // THE GOLDEN BYTES. bmRequestType 0x21 = host-to-device (bit 7 clear),
  // type CLASS (0b01 << 5), recipient INTERFACE (0b00001) - the same
  // combination picotool sends over libusb. bRequest 0x01 is
  // RESET_REQUEST_BOOTSEL. wValue 0x0000 leaves the bootrom's
  // disable_interface_mask at zero (mass storage AND PICOBOOT both stay
  // up, which is what the flasher needs on the far side) and declares no
  // activity-LED GPIO. wIndex is the reset interface number, which the
  // firmware compares against the interface it was opened as. wLength 0:
  // there is no data stage.
  test("wire bytes for interface 2 are 21 01 00 00 02 00 00 00", () => {
    const bytes = encodeSetupPacket(buildBootselResetSetup(2));
    expect(Array.from(bytes)).toEqual([0x21, 0x01, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00]);
  });

  test("wIndex is little-endian and follows the interface number, never hardcoded", () => {
    expect(Array.from(encodeSetupPacket(buildBootselResetSetup(0)))).toEqual([
      0x21, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00,
    ]);
    expect(Array.from(encodeSetupPacket(buildBootselResetSetup(0x0102)))).toEqual([
      0x21, 0x01, 0x00, 0x00, 0x02, 0x01, 0x00, 0x00,
    ]);
  });

  test("the requestType/recipient encoding is the USB one, not an arbitrary map", () => {
    const at = (requestType: "standard" | "class" | "vendor", recipient: "device" | "interface" | "endpoint" | "other") =>
      encodeSetupPacket({ requestType, recipient, request: 0, value: 0, index: 0 })[0];
    expect(at("standard", "device")).toBe(0x00);
    expect(at("standard", "interface")).toBe(0x01);
    expect(at("class", "device")).toBe(0x20);
    expect(at("class", "interface")).toBe(0x21);
    expect(at("vendor", "interface")).toBe(0x41);
    expect(at("vendor", "endpoint")).toBe(0x42);
    expect(at("vendor", "other")).toBe(0x43);
  });

  test("wValue and wLength are little-endian too", () => {
    const bytes = encodeSetupPacket(
      { requestType: "vendor", recipient: "device", request: 0xab, value: 0xbeef, index: 0 },
      0x0140
    );
    expect(Array.from(bytes)).toEqual([0x40, 0xab, 0xef, 0xbe, 0x00, 0x00, 0x40, 0x01]);
  });
});

describe("findResetInterface", () => {
  // Minimal stand-ins for the descriptor shape WebUSB exposes. Only the
  // fields findResetInterface() reads are present, so a change that starts
  // reading something else fails to compile here rather than passing on a
  // fake that lies.
  function alt(interfaceClass: number, interfaceSubclass: number, interfaceProtocol: number, endpoints: unknown[] = []) {
    return { alternateSetting: 0, interfaceClass, interfaceSubclass, interfaceProtocol, interfaceName: null, endpoints };
  }
  function device(interfaces: Array<{ interfaceNumber: number; alternates: unknown[] }>): USBDevice {
    return {
      configuration: { configurationValue: 1, configurationName: null, interfaces },
    } as unknown as USBDevice;
  }
  const bulkIn = { endpointNumber: 1, direction: "in", type: "bulk", packetSize: 64 };
  const bulkOut = { endpointNumber: 1, direction: "out", type: "bulk", packetSize: 64 };

  // What a running puck actually enumerates as: CDC control (class 0x02),
  // CDC data (class 0x0A), then the reset interface at number 2.
  const runningPuck = device([
    { interfaceNumber: 0, alternates: [alt(0x02, 0x02, 0x00, [{ ...bulkIn, type: "interrupt" }])] },
    { interfaceNumber: 1, alternates: [alt(0x0a, 0x00, 0x00, [bulkIn, bulkOut])] },
    { interfaceNumber: 2, alternates: [alt(0xff, 0x00, 0x01)] },
  ]);

  test("finds the vendor/0x00/0x01 endpointless interface on a running puck", () => {
    expect(findResetInterface(runningPuck)).toBe(2);
  });

  test("returns null for firmware built before the reset interface existed (CDC only)", () => {
    const old = device([
      { interfaceNumber: 0, alternates: [alt(0x02, 0x02, 0x00, [{ ...bulkIn, type: "interrupt" }])] },
      { interfaceNumber: 1, alternates: [alt(0x0a, 0x00, 0x00, [bulkIn, bulkOut])] },
    ]);
    expect(findResetInterface(old)).toBe(null);
  });

  test("does not mistake PICOBOOT for the reset interface", () => {
    // PICOBOOT is also class 0xFF, and that is exactly why the subclass,
    // the protocol and the endpoint count all have to be checked: a
    // BOOTSEL device must never be handed a reset request.
    const bootsel = device([
      { interfaceNumber: 0, alternates: [alt(0x08, 0x06, 0x50, [bulkIn, bulkOut])] },
      { interfaceNumber: 1, alternates: [alt(0xff, 0x00, 0x00, [bulkIn, bulkOut])] },
    ]);
    expect(findResetInterface(bootsel)).toBe(null);
  });

  test("a vendor interface with the right triple but endpoints is not it", () => {
    const impostor = device([{ interfaceNumber: 0, alternates: [alt(0xff, 0x00, 0x01, [bulkIn])] }]);
    expect(findResetInterface(impostor)).toBe(null);
  });

  test("an unconfigured device yields null rather than throwing", () => {
    expect(findResetInterface({ configuration: null } as unknown as USBDevice)).toBe(null);
  });
});
