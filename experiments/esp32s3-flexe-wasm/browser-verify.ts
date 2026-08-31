import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import puppeteer from "puppeteer-core";
import { closeBrowser } from "../../scripts/browserClose";

const root = join(import.meta.dir, "../..");
const modulePath = join(import.meta.dir, "dist", "flexe-probe-freestanding.wasm");

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/chromium-browser",
  ];
  const match = candidates.find((candidate): candidate is string => Boolean(candidate && existsSync(candidate)));
  if (!match) throw new Error("no local Chrome found; set CHROME_PATH");
  return match;
}

function syntheticElf(): Uint8Array {
  const headerBytes = 52;
  const programHeaderBytes = 32;
  const programHeaders = 2;
  const payloadOffset = headerBytes + programHeaderBytes * programHeaders;
  const code = Uint8Array.from([0x32, 0xa0, 0x28]);
  const bytes = new Uint8Array(payloadOffset + code.length);
  bytes.set([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]);
  bytes.set(code, payloadOffset);
  const view = new DataView(bytes.buffer);
  view.setUint16(16, 2, true);
  view.setUint16(18, 94, true);
  view.setUint32(20, 1, true);
  view.setUint32(24, 0x4037_1000, true);
  view.setUint32(28, headerBytes, true);
  view.setUint16(40, headerBytes, true);
  view.setUint16(42, programHeaderBytes, true);
  view.setUint16(44, programHeaders, true);

  view.setUint32(headerBytes, 1, true);
  view.setUint32(headerBytes + 4, payloadOffset, true);
  view.setUint32(headerBytes + 8, 0x4037_1000, true);
  view.setUint32(headerBytes + 12, 0x4037_1000, true);
  view.setUint32(headerBytes + 16, code.length, true);
  view.setUint32(headerBytes + 20, code.length, true);
  view.setUint32(headerBytes + 24, 5, true);
  view.setUint32(headerBytes + 28, 1, true);

  const dataHeader = headerBytes + programHeaderBytes;
  view.setUint32(dataHeader, 1, true);
  view.setUint32(dataHeader + 4, bytes.length, true);
  view.setUint32(dataHeader + 8, 0x3fce_9000, true);
  view.setUint32(dataHeader + 12, 0x3fce_9000, true);
  view.setUint32(dataHeader + 16, 0, true);
  view.setUint32(dataHeader + 20, 0x1000, true);
  view.setUint32(dataHeader + 24, 6, true);
  view.setUint32(dataHeader + 28, 1, true);
  return bytes;
}

async function waitForServer(url: string): Promise<void> {
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    try {
      if ((await fetch(url)).ok) return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("browser runner server did not start");
}

function candidatePorts(): number[] {
  const base = 53_000 + (process.pid % 256);
  return Array.from({ length: 8 }, (_, index) => base + index);
}

function spawnServer(port: number) {
  const processHandle = Bun.spawn([process.execPath, "run", "experiments/esp32s3-flexe-wasm/browser-server.ts"], {
    cwd: root,
    env: { ...process.env, PORT: String(port) },
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    port,
    process: processHandle,
    stdout: processHandle.stdout ? new Response(processHandle.stdout).text() : Promise.resolve(""),
    stderr: processHandle.stderr ? new Response(processHandle.stderr).text() : Promise.resolve(""),
  };
}

if (!existsSync(modulePath)) throw new Error("freestanding module is not built; run build.ts first");
const temporary = mkdtempSync(join(tmpdir(), "puck-s3-browser-"));
const elfPath = join(temporary, "bounded.elf");
writeFileSync(elfPath, syntheticElf());
let server:
  | {
      port: number;
      process: ReturnType<typeof Bun.spawn>;
      stdout: Promise<string>;
      stderr: Promise<string>;
    }
  | null = null;
let browser: Awaited<ReturnType<typeof puppeteer.launch>> | null = null;

try {
  for (const port of candidatePorts()) {
    const candidate = spawnServer(port);
    try {
      await waitForServer(`http://127.0.0.1:${port}/`);
      server = candidate;
      break;
    } catch (error) {
      candidate.process.kill();
      const [stdout, stderr] = await Promise.all([candidate.stdout, candidate.stderr]);
      const details = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      if (details.includes("EADDRINUSE")) continue;
      throw new Error(details ? `${String(error)}\n${details}` : String(error));
    }
  }
  if (!server) throw new Error("browser runner server did not start after trying 8 local ports");
  browser = await puppeteer.launch({ executablePath: findChrome(), headless: true });
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 900 });
  const pageErrors: string[] = [];
  page.on("pageerror", (error) => pageErrors.push(error instanceof Error ? error.message : String(error)));
  await page.goto(`http://127.0.0.1:${server.port}/`, { waitUntil: "domcontentloaded" });
  const fileInput = await page.$("input#elfFile");
  if (!fileInput) throw new Error("ELF file input is missing");
  await fileInput.uploadFile(elfPath);
  await page.click("#gateMemory");
  await page.$eval("#maxSteps", (element) => {
    const input = element as HTMLInputElement;
    input.value = "1";
  });
  await page.$eval("#initialStack", (element) => {
    const input = element as HTMLInputElement;
    input.value = "0x3fcea000";
  });
  await page.click("#run");
  await page.waitForFunction(() => !document.querySelector<HTMLElement>("#result")?.hidden);

  const result = await page.evaluate(() => ({
    stopReason: document.querySelector("#stopReason")?.textContent,
    pc: document.querySelector("#pc")?.textContent,
    steps: document.querySelector("#steps")?.textContent,
    registers: Array.from(document.querySelectorAll("#registers code"), (element) => element.textContent),
    trace: document.querySelector("#trace")?.textContent,
  }));
  if (pageErrors.length > 0) throw new Error(`page errors: ${pageErrors.join("; ")}`);
  if (result.stopReason !== "maxSteps") throw new Error(`unexpected stop reason ${result.stopReason}`);
  if (result.pc !== "0x40371003") throw new Error(`unexpected PC ${result.pc}`);
  if (result.steps !== "1") throw new Error(`unexpected step count ${result.steps}`);
  if (result.registers[3] !== "0x00000028") throw new Error(`unexpected a3 ${result.registers[3]}`);
  if (!result.trace?.includes("1 instructions")) throw new Error(`unexpected trace summary ${result.trace}`);
  console.log(JSON.stringify(result, null, 2));
} finally {
  if (browser) await closeBrowser(browser);
  server?.process.kill();
  rmSync(temporary, { recursive: true, force: true });
}
