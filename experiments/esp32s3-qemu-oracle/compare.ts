import { resolve } from "node:path";
import { DEFAULT_CORPUS_PATH, DEFAULT_FIXTURE_OBSERVATION_PATH } from "./constants";
import { compareObservationToCorpus, loadCorpus, loadObservationSet } from "./oracle";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function parseArgs(argv: readonly string[]): { corpusPath: string; observationPath: string } {
  let corpusPath = DEFAULT_CORPUS_PATH;
  let observationPath = DEFAULT_FIXTURE_OBSERVATION_PATH;
  for (let index = 0; index < argv.length; index++) {
    if (argv[index] === "--corpus") {
      assert(index + 1 < argv.length, "--corpus needs a path");
      corpusPath = resolve(argv[index + 1]!);
      index += 1;
      continue;
    }
    if (argv[index] === "--observation") {
      assert(index + 1 < argv.length, "--observation needs a path");
      observationPath = resolve(argv[index + 1]!);
      index += 1;
      continue;
    }
    throw new Error(`unknown argument ${argv[index]}`);
  }
  return { corpusPath, observationPath };
}

const args = parseArgs(Bun.argv.slice(2));
const corpus = loadCorpus(args.corpusPath);
const observation = loadObservationSet(args.observationPath);
const mismatches = compareObservationToCorpus(corpus, observation);
assert(mismatches.length === 0, mismatches.join("\n"));

console.log(JSON.stringify({
  cases: corpus.cases.length,
  qemuCommit: observation.oracle.commit,
  qemuSha256: observation.oracle.qemuSha256,
}, null, 2));
