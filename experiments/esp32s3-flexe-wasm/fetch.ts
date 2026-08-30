import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { DEFAULT_FLEXE_SOURCE, FLEXE_COMMIT, FLEXE_REPOSITORY } from "./constants";
import { requireSuccess, run, verifySource } from "./lib";

const source = resolve(process.env.FLEXE_SOURCE ?? DEFAULT_FLEXE_SOURCE);

if (!existsSync(source)) {
  mkdirSync(dirname(source), { recursive: true });
  requireSuccess(run(["git", "clone", "--no-checkout", FLEXE_REPOSITORY, source]));
  requireSuccess(run(["git", "checkout", "--detach", FLEXE_COMMIT], source));
}

verifySource(source);
console.log(source);

