import { existsSync, statSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;
const BUILD = join(ROOT, "build");
const OUTPUT = join(ROOT, "dist", "cxx_reactor.wasm");
const VERSIONS = join(ROOT, ".wasi-versions");
const DEFAULT_HOMEBREW_CXX = "/opt/homebrew/opt/llvm/bin/clang++";
const CXX = process.env.WASI_CXX ??
  (existsSync(DEFAULT_HOMEBREW_CXX) ? DEFAULT_HOMEBREW_CXX : "clang++");

function run(command: string[]): void {
  console.log(command.join(" "));
  const result = Bun.spawnSync(command, { stdout: "inherit", stderr: "inherit" });
  if (!result.success) process.exit(result.exitCode ?? 1);
}

function output(command: string[]): string | null {
  const result = Bun.spawnSync(command, { stdout: "pipe", stderr: "pipe" });
  return result.success ? result.stdout.toString().trim() : null;
}

async function warnOnVersionMismatch(): Promise<void> {
  const expected = new Map(
    (await Bun.file(VERSIONS).text())
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => line.split("=", 2) as [string, string]),
  );
  const compilerLine = output([CXX, "--version"])?.split("\n", 1)[0] ?? "";
  const compilerVersion = compilerLine.match(/(?:clang version|Clang version)\s+(\d+(?:\.\d+)+)/)?.[1];
  if (!compilerVersion || compilerVersion !== expected.get("llvm")) {
    console.warn(
      `warning: recorded llvm=${expected.get("llvm")}, but ${CXX} reports ${compilerVersion ?? "an unknown version"}; ` +
        "continuing because toolchain version drift is advisory",
    );
  }

  const brew = Bun.which("brew");
  if (!brew) {
    console.warn("warning: Homebrew is unavailable, so recorded wasi-libc and wasi-runtimes versions could not be checked");
    return;
  }
  for (const formula of ["wasi-libc", "wasi-runtimes"]) {
    const installed = output([brew, "list", "--versions", formula])?.split(/\s+/)[1];
    if (!installed || installed !== expected.get(formula)) {
      console.warn(
        `warning: recorded ${formula}=${expected.get(formula)}, but Homebrew reports ${installed ?? "not installed"}; ` +
          "continuing because toolchain version drift is advisory",
      );
    }
  }
}

await warnOnVersionMismatch();
run([
  "cmake",
  "-S", ROOT,
  "-B", BUILD,
  "-G", "Ninja",
  "-DCMAKE_BUILD_TYPE=Release",
  "-DCMAKE_SYSTEM_NAME=Generic",
  `-DCMAKE_CXX_COMPILER=${CXX}`,
  "-DCMAKE_CXX_COMPILER_TARGET=wasm32-wasip1",
]);
run(["cmake", "--build", BUILD, "--target", "cxx_reactor"]);
console.log(`built ${OUTPUT} (${statSync(OUTPUT).size} bytes)`);
