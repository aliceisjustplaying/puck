import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { FLEXE_COMMIT, SOURCE_HASHES } from "./constants";

export interface CommandResult {
  command: string;
  exitCode: number;
  stdout: string;
  stderr: string;
}

export function run(command: string[], cwd?: string, env?: Record<string, string>): CommandResult {
  const result = Bun.spawnSync(command, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe"
  });
  return {
    command: command.join(" "),
    exitCode: result.exitCode,
    stdout: result.stdout.toString(),
    stderr: result.stderr.toString()
  };
}

export function requireSuccess(result: CommandResult): void {
  if (result.exitCode === 0) return;
  throw new Error(
    `${result.command} exited ${result.exitCode}\n` +
      `${result.stdout}${result.stderr}`
  );
}

export function sha256(path: string): string {
  return createHash("sha256").update(readFileSync(path)).digest("hex");
}

export function verifySource(source: string): void {
  if (!existsSync(join(source, ".git"))) {
    throw new Error(`${source} is not a flexe git checkout; run fetch.ts first`);
  }
  const head = run(["git", "rev-parse", "HEAD"], source);
  requireSuccess(head);
  if (head.stdout.trim() !== FLEXE_COMMIT) {
    throw new Error(`${source} is at ${head.stdout.trim()}, expected ${FLEXE_COMMIT}`);
  }
  const dirty = run(["git", "status", "--porcelain"], source);
  requireSuccess(dirty);
  if (dirty.stdout.trim() !== "") {
    throw new Error(`${source} has local changes; the probe only accepts the exact clean pinned tree`);
  }
  for (const [relative, expected] of Object.entries(SOURCE_HASHES)) {
    const actual = sha256(join(source, relative));
    if (actual !== expected) {
      throw new Error(`${relative} has sha256 ${actual}, expected ${expected}`);
    }
  }
}

export function commandVersion(command: string): string {
  const result = run([command, "version"]);
  requireSuccess(result);
  return result.stdout.trim();
}

