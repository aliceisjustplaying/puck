// WASI-lite: four deterministic shims, provided only to a module that asks
// for them, and never a byte more of WASI than that.
//
// Why this exists at all. The ABI a puck module implements is emu_abi.h,
// and nothing in it needs an operating system: emu_tick(nowMs) hands the
// guest its clock, env.js_log hands it a console. But some toolchains
// cannot emit a module without a few wasi_snapshot_preview1 imports even
// when the program never calls them: a C++ front end that links its own
// runtime startup, a language whose standard library assumes a hosted
// target. Before this file, such a module could not be loaded at all, and
// the author's only move was to fight their own toolchain. Now it loads,
// as long as everything it imports is on the short list below.
//
// Why these four, and why they behave the way they do: see
// docs/decisions/0004-wasi-lite-not-wasi.md. The short version is that
// every one of them is answered from state this repository already
// replays exactly (the trace's own tick timestamps, a seed carried by the
// trace itself), so a module using them replays bit-identically in the
// page, in the harness and in CI. A shim that read the wall clock, the
// real entropy pool or the filesystem would break that, which is why
// there is no fifth function here and why an unsupported import is a hard
// error rather than a stub returning zero: a silent stub would turn a
// missing capability into wrong behaviour discovered much later.
//
// Nothing here names a device (AGENTS.md): these shims are as
// device-agnostic as the rest of src/.

// The one WASI module namespace this repository knows about. WASI
// preview 2 / the component model use different namespaces entirely and
// are not supported: a module importing those gets the same hard error as
// any other unsupported import.
export const WASI_MODULE = "wasi_snapshot_preview1";

// The whole supported surface. Sorted, because the error message below
// prints it and a stable order makes that message diffable.
export const SUPPORTED_WASI_IMPORTS = ["clock_time_get", "fd_write", "proc_exit", "random_get"] as const;

// The seed a trace gets when it does not carry one of its own (Trace.seed,
// src/recorder.ts). A fixed constant, not a timestamp and not a random
// draw: the whole point is that replaying the same trace twice, on two
// machines, in two years, produces the same bytes out of random_get. The
// value itself is arbitrary ("PUK1" as ASCII).
export const DEFAULT_TRACE_SEED = 0x50554b31;

// WASI's own errno values, only the two this file can ever return.
const ERRNO_SUCCESS = 0;
const ERRNO_BADF = 8;

// stdout and stderr both land in the same sink as env.js_log: this page
// shows one console (src/consolelog.ts), and a module that writes a
// diagnostic should not have it disappear because it chose fd 2. Every
// other fd is refused with EBADF rather than silently accepted, since a
// module writing to a file descriptor puck never opened is doing
// something this host genuinely cannot honour.
const FD_STDOUT = 1;
const FD_STDERR = 2;

// mulberry32: 32 bits of state, one multiply-xorshift round per draw.
// Chosen for being small enough to read in one sitting and identical
// across every JavaScript engine (all arithmetic is forced back into
// uint32 with >>> 0 and Math.imul, so there is no float rounding anywhere
// in the state update). Statistical quality is irrelevant here; exact
// reproducibility is the entire requirement.
export function makePrng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) & 0xff;
  };
}

// The wasi_snapshot_preview1 imports a compiled module actually asks for,
// in the order WebAssembly.Module.imports() reports them, deduplicated.
export function wasiImportNames(imports: WebAssembly.ModuleImportDescriptor[]): string[] {
  const seen = new Set<string>();
  for (const imp of imports) {
    if (imp.module === WASI_MODULE) seen.add(imp.name);
  }
  return [...seen];
}

// Whatever the module asked for that this file does not provide. Returned
// as a list, not a boolean, so the error names every offender at once
// instead of making an author rebuild to discover the next one.
export function unsupportedWasiImports(names: string[]): string[] {
  const supported = new Set<string>(SUPPORTED_WASI_IMPORTS);
  return names.filter((n) => !supported.has(n)).sort();
}

export function unsupportedWasiMessage(unsupported: string[]): string {
  return (
    `wasm module imports ${unsupported.map((n) => `${WASI_MODULE}.${n}`).join(", ")}, which this emulator does not provide. ` +
    `Supported ${WASI_MODULE} imports: ${SUPPORTED_WASI_IMPORTS.join(", ")}. ` +
    `This is WASI-lite, not WASI: only imports that can be answered deterministically from a trace are shimmed ` +
    `(see docs/decisions/0004-wasi-lite-not-wasi.md). Build against wasm32-freestanding, or stop linking whatever pulls these in.`
  );
}

// Thrown by the proc_exit shim. A distinct class so a caller can tell "the
// module deliberately halted" apart from "the module trapped", even though
// both stop the call the same way.
export class ProcExitError extends Error {
  readonly code: number;
  constructor(code: number) {
    super(
      `module called ${WASI_MODULE}.proc_exit(${code}): a puck module never exits, it returns from emu_tick() and is called again. ` +
        `This halt is fatal for this instance; nothing after it ran.`
    );
    this.code = code;
    this.name = "ProcExitError";
  }
}

export interface WasiLiteHost {
  // Same sink env.js_log writes to (src/wasm.ts passes the identical
  // callback), so a module's printf and its js_log interleave in one
  // console instead of two.
  onLog(text: string): void;
  // Read late, not captured: the memory only exists after instantiation,
  // and these shims can be called during it (a module's start function).
  getMemory(): WebAssembly.Memory | undefined;
  // The last nowMs handed to emu_tick, in milliseconds. 0 before the first
  // tick: a module that reads the clock before the host ever set one is
  // reading a clock that has not started, and 0 is the honest answer.
  nowMs(): number;
  // Trace.seed, or DEFAULT_TRACE_SEED.
  seed: number;
}

export function buildWasiLite(host: WasiLiteHost): WebAssembly.ModuleImports {
  const nextByte = makePrng(host.seed);

  const view = (): DataView | null => {
    const memory = host.getMemory();
    return memory ? new DataView(memory.buffer) : null;
  };

  return {
    // fd_write(fd, iovs, iovs_len, nwritten) -> errno
    // One log entry per line written, trailing newline stripped: an entry
    // in this repo's console is a line (env.js_log's own contract), and a
    // printf that ends in "\n" should not produce an empty second entry.
    // A write with no newline at all is still emitted immediately rather
    // than held back waiting for one, so a module that prints a progress
    // marker without a newline is not silently invisible.
    fd_write: (fd: number, iovsPtr: number, iovsLen: number, nwrittenPtr: number): number => {
      if (fd !== FD_STDOUT && fd !== FD_STDERR) return ERRNO_BADF;
      const memory = host.getMemory();
      const dv = view();
      if (!memory || !dv) return ERRNO_BADF;
      const bytes: number[] = [];
      let written = 0;
      for (let i = 0; i < iovsLen; i++) {
        const base = iovsPtr + i * 8;
        const ptr = dv.getUint32(base, true);
        const len = dv.getUint32(base + 4, true);
        const chunk = new Uint8Array(memory.buffer, ptr, len);
        for (const b of chunk) bytes.push(b);
        written += len;
      }
      const text = new TextDecoder().decode(new Uint8Array(bytes));
      const lines = text.split("\n");
      if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
      for (const line of lines) host.onLog(line);
      dv.setUint32(nwrittenPtr, written, true);
      return ERRNO_SUCCESS;
    },

    // clock_time_get(clock_id, precision, time_ptr) -> errno
    // Every clock id answers with the same value, the emulator's own
    // synthetic clock: this host has exactly one clock (emu_tick's nowMs),
    // and pretending to distinguish MONOTONIC from REALTIME would be
    // inventing a second one that no replay could reproduce. i64
    // parameters arrive as BigInt, and the result is written as a BigUint64
    // because that is what a WASI timestamp is: nanoseconds.
    clock_time_get: (_clockId: number, _precision: bigint, timePtr: number): number => {
      const dv = view();
      if (!dv) return ERRNO_BADF;
      const ns = BigInt(Math.max(0, Math.floor(host.nowMs()))) * 1_000_000n;
      dv.setBigUint64(timePtr, ns, true);
      return ERRNO_SUCCESS;
    },

    // random_get(buf, buf_len) -> errno
    // Deterministic by construction: one PRNG per instance, seeded from
    // the trace. Two instantiations of the same bytes with the same seed
    // therefore see the same sequence, which is what makes a module that
    // uses randomness replayable at all.
    random_get: (bufPtr: number, bufLen: number): number => {
      const memory = host.getMemory();
      if (!memory) return ERRNO_BADF;
      const out = new Uint8Array(memory.buffer, bufPtr, bufLen);
      for (let i = 0; i < bufLen; i++) out[i] = nextByte();
      return ERRNO_SUCCESS;
    },

    // proc_exit(code) -> never
    // Mapped to a trap, deliberately: WASI says this call does not return,
    // and the only way to honour "does not return" from a JavaScript host
    // is to throw. The alternative (return normally and set a flag) would
    // let the module keep running past its own exit, which is worse than
    // stopping.
    proc_exit: (code: number): never => {
      throw new ProcExitError(code);
    },
  };
}
