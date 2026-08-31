import { runSparseXtensaElf } from "../full-elf-runner";
import {
  DEFAULT_INITIAL_STACK,
  DEFAULT_MAX_STEPS,
  GATE_HARNESS_STACK_MEMORY,
  hex32,
  parseAddress,
  parseBrowserElf,
  parseStepLimit,
  summarizeRun,
} from "./core";

const elfInput = document.querySelector<HTMLInputElement>("#elfFile")!;
const stepInput = document.querySelector<HTMLInputElement>("#maxSteps")!;
const stackInput = document.querySelector<HTMLInputElement>("#initialStack")!;
const gateMemoryInput = document.querySelector<HTMLInputElement>("#gateMemory")!;
const runButton = document.querySelector<HTMLButtonElement>("#run")!;
const status = document.querySelector<HTMLElement>("#status")!;
const resultPanel = document.querySelector<HTMLElement>("#result")!;
const stopReason = document.querySelector<HTMLElement>("#stopReason")!;
const pc = document.querySelector<HTMLElement>("#pc")!;
const steps = document.querySelector<HTMLElement>("#steps")!;
const pages = document.querySelector<HTMLElement>("#pages")!;
const registers = document.querySelector<HTMLElement>("#registers")!;
const trace = document.querySelector<HTMLElement>("#trace")!;

stepInput.value = String(DEFAULT_MAX_STEPS);
stackInput.value = hex32(DEFAULT_INITIAL_STACK);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function setStatus(text: string, failed = false): void {
  status.textContent = text;
  status.classList.toggle("error", failed);
}

function renderRegisters(values: readonly string[]): void {
  registers.replaceChildren(...values.map((value, index) => {
    const row = document.createElement("div");
    const name = document.createElement("span");
    const registerValue = document.createElement("code");
    name.textContent = `a${index}`;
    registerValue.textContent = value;
    row.append(name, registerValue);
    return row;
  }));
}

runButton.addEventListener("click", () => {
  void (async () => {
    const file = elfInput.files?.[0];
    if (!file) {
      setStatus("Choose an ESP32-S3 ELF first.", true);
      return;
    }
    runButton.disabled = true;
    resultPanel.hidden = true;
    setStatus(`Loading ${file.name}...`);
    try {
      const [moduleResponse, image] = await Promise.all([
        fetch("/flexe-probe-freestanding.wasm", { cache: "no-store" }),
        file.arrayBuffer().then((bytes) => parseBrowserElf(new Uint8Array(bytes))),
      ]);
      if (!moduleResponse.ok) throw new Error(await moduleResponse.text());
      const moduleBytes = await moduleResponse.arrayBuffer();
      const maxSteps = parseStepLimit(stepInput.value);
      const initialStack = parseAddress(stackInput.value);
      setStatus(`Running from ${hex32(image.entryPoint)}...`);
      const result = await runSparseXtensaElf(moduleBytes, image, {
        initialStack,
        maxSteps,
        inheritedZeroRanges: gateMemoryInput.checked ? [GATE_HARNESS_STACK_MEMORY] : [],
      });
      const summary = summarizeRun(result);
      stopReason.textContent = summary.stopReason;
      pc.textContent = summary.pc;
      steps.textContent = String(summary.steps);
      pages.textContent = String(summary.loadedPages);
      renderRegisters(summary.registers);
      trace.textContent = [
        `${summary.trace.records}/${summary.trace.capacity} records`,
        `${summary.trace.instructions} instructions`,
        `${summary.trace.reads} reads`,
        `${summary.trace.writes} writes`,
        `overflow ${summary.trace.overflow ? "yes" : "no"}`,
        `first ${summary.trace.firstPc === null ? "none" : hex32(summary.trace.firstPc)}`,
        `last ${summary.trace.lastPc === null ? "none" : hex32(summary.trace.lastPc)}`,
      ].join(" · ");
      setStatus(`${file.name} stopped after ${summary.steps} step${summary.steps === 1 ? "" : "s"}.`);
      resultPanel.hidden = false;
    } catch (error) {
      setStatus(errorText(error), true);
    } finally {
      runButton.disabled = false;
    }
  })();
});
