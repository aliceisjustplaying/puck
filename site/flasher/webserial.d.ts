// site/flasher/webserial.d.ts: the slice of the Web Serial API this flasher
// uses, plus the ambient names esptool-js's own typings expect to find.
//
// Same reasoning as webusb.d.ts next to it: TypeScript's "DOM" lib does not
// ship Web Serial, and this repo declares the handful of interfaces one
// feature needs rather than taking an @types dependency for them. esptool-js
// asks for the `w3c-web-serial` types by reference; the declarations below are
// global, so they answer for its `SerialPort`, `ParityType` and
// `FlowControlType` too.
//
// Scoped to what site/flasher/esp32.ts actually touches: navigator.serial
// existing at all (the unsupported-browser check), requestPort() (the picker,
// a user gesture), and the SerialPort object it returns, which is handed
// straight to esptool-js's Transport and never driven from our own code.

type ParityType = "none" | "even" | "odd";
type FlowControlType = "none" | "hardware";

interface SerialPortInfo {
  readonly usbVendorId?: number;
  readonly usbProductId?: number;
}

interface SerialOptions {
  baudRate: number;
  dataBits?: number;
  stopBits?: number;
  parity?: ParityType;
  bufferSize?: number;
  flowControl?: FlowControlType;
}

interface SerialOutputSignals {
  dataTerminalReady?: boolean;
  requestToSend?: boolean;
  break?: boolean;
}

interface SerialInputSignals {
  readonly dataCarrierDetect: boolean;
  readonly clearToSend: boolean;
  readonly ringIndicator: boolean;
  readonly dataSetReady: boolean;
}

interface SerialPort {
  readonly readable: ReadableStream<Uint8Array> | null;
  readonly writable: WritableStream<Uint8Array> | null;
  open(options: SerialOptions): Promise<void>;
  close(): Promise<void>;
  forget?(): Promise<void>;
  getInfo(): SerialPortInfo;
  setSignals(signals: SerialOutputSignals): Promise<void>;
  getSignals(): Promise<SerialInputSignals>;
  addEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions): void;
  removeEventListener(type: string, listener: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions): void;
}

interface SerialPortFilter {
  usbVendorId?: number;
  usbProductId?: number;
}

interface SerialPortRequestOptions {
  filters?: SerialPortFilter[];
}

interface Serial extends EventTarget {
  getPorts(): Promise<SerialPort[]>;
  requestPort(options?: SerialPortRequestOptions): Promise<SerialPort>;
}

interface Navigator {
  readonly serial?: Serial;
}
