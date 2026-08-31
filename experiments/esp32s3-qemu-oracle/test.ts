import assert from "node:assert/strict";
import {
  compareObservationToCorpus,
  formatHexWord,
  loadCorpus,
  loadObservationSet,
  type OracleObservationSet,
} from "./oracle";
import { detectLiveOracleEnvironment, runLiveOracle } from "./run";

const corpus = loadCorpus();
const fixture = loadObservationSet();
assert.deepEqual(compareObservationToCorpus(corpus, fixture), [], "fixture observation drifted");

const mismatchFixture: OracleObservationSet = {
  ...fixture,
  cases: fixture.cases.map((entry) =>
    entry.id === "scalar_probe"
      ? { ...entry, finalPc: (entry.finalPc + 1) >>> 0 }
      : entry,
  ),
};
assert.deepEqual(
  compareObservationToCorpus(corpus, mismatchFixture),
  ["scalar_probe changed final PC"],
  "comparator did not catch a final PC mismatch",
);

const detected = detectLiveOracleEnvironment();
let live = "skipped";
let skipReason: string[] = [];
if (detected.ready) {
  const liveObservation = await runLiveOracle(corpus, detected.value);
  assert.deepEqual(compareObservationToCorpus(corpus, liveObservation), [], "live QEMU observation drifted");
  live = "verified";
} else {
  skipReason = detected.reason;
}

console.log(JSON.stringify({
  cases: corpus.cases.length,
  scalarFinalPc: formatHexWord(corpus.cases[0]!.finalPc),
  fixture: "matched",
  live,
  skipReason,
}, null, 2));
