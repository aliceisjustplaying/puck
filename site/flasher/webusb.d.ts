// site/flasher/webusb.d.ts: the slice of the WebUSB API this flasher uses.
//
// Not shipped by TypeScript's own "DOM" lib, and this repo takes no
// dependency on @types/w3c-web-usb (or any npm package) for a handful of
// interfaces used by one feature. Hand-declared against the WebUSB spec
// (https://wicg.github.io/webusb/), scoped to exactly what picoboot.ts and
// flash.ts call: requestDevice, getDevices, open/close,
// selectConfiguration, claim/releaseInterface, transferIn/Out,
// controlTransferOut, clearHalt, and enough of the
// USBConfiguration/USBInterface/USBEndpoint shape to find the PICOBOOT
// vendor interface's bulk endpoints and the reset interface's
// class/subclass/protocol triple.

interface USBEndpoint {
  readonly endpointNumber: number;
  readonly direction: "in" | "out";
  readonly type: "bulk" | "interrupt" | "isochronous";
  readonly packetSize: number;
}

interface USBAlternateInterface {
  readonly alternateSetting: number;
  readonly interfaceClass: number;
  readonly interfaceSubclass: number;
  readonly interfaceProtocol: number;
  readonly interfaceName: string | null;
  readonly endpoints: USBEndpoint[];
}

interface USBInterface {
  readonly interfaceNumber: number;
  readonly alternate: USBAlternateInterface;
  readonly alternates: USBAlternateInterface[];
  readonly claimed: boolean;
}

interface USBConfiguration {
  readonly configurationValue: number;
  readonly configurationName: string | null;
  readonly interfaces: USBInterface[];
}

interface USBInTransferResult {
  readonly data?: DataView;
  readonly status: "ok" | "stall" | "babble";
}

interface USBOutTransferResult {
  readonly bytesWritten: number;
  readonly status: "ok" | "stall";
}

// The control-transfer setup, minus the direction bit and wLength, which
// WebUSB derives from which of controlTransferIn/Out is called and from
// the data it is given. flash.ts only ever issues an OUT with no data
// stage (the reboot-to-BOOTSEL request), so wLength is always 0 there.
interface USBControlTransferParameters {
  requestType: "standard" | "class" | "vendor";
  recipient: "device" | "interface" | "endpoint" | "other";
  request: number;
  value: number;
  index: number;
}

interface USBDeviceFilter {
  vendorId?: number;
  productId?: number;
  classCode?: number;
  subclassCode?: number;
  protocolCode?: number;
  serialNumber?: string;
}

interface USBDeviceRequestOptions {
  filters: USBDeviceFilter[];
}

interface USBDevice {
  readonly vendorId: number;
  readonly productId: number;
  readonly productName?: string;
  readonly opened: boolean;
  readonly configuration: USBConfiguration | null;
  readonly configurations: USBConfiguration[];
  open(): Promise<void>;
  close(): Promise<void>;
  selectConfiguration(configurationValue: number): Promise<void>;
  claimInterface(interfaceNumber: number): Promise<void>;
  releaseInterface(interfaceNumber: number): Promise<void>;
  transferIn(endpointNumber: number, length: number): Promise<USBInTransferResult>;
  transferOut(endpointNumber: number, data: Uint8Array): Promise<USBOutTransferResult>;
  controlTransferOut(setup: USBControlTransferParameters, data?: BufferSource): Promise<USBOutTransferResult>;
  clearHalt(direction: "in" | "out", endpointNumber: number): Promise<void>;
  reset(): Promise<void>;
}

interface USB extends EventTarget {
  getDevices(): Promise<USBDevice[]>;
  requestDevice(options: USBDeviceRequestOptions): Promise<USBDevice>;
}

interface Navigator {
  readonly usb?: USB;
}
