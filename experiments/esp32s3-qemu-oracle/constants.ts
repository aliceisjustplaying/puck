export const QEMU_ORACLE_CORPUS_SCHEMA = "puck/esp32s3-qemu-corpus@v1";
export const QEMU_ORACLE_OBSERVATION_SCHEMA = "puck/esp32s3-qemu-observation@v1";
export const QEMU_ORACLE_TERMINATION = "instructionBudgetReached";
export const ESPRESSIF_QEMU_REPOSITORY = "https://github.com/espressif/qemu";
export const ESPRESSIF_QEMU_BRANCH = "esp-develop";
export const ESPRESSIF_QEMU_COMMIT = "febae182e132e4055529be423a818225ebddaa3a";
export const ESPRESSIF_QEMU_LICENSE = "GPL-2.0-only";
export const FLEXE_REPOSITORY = "https://github.com/levkropp/flexe";
export const FLEXE_COMMIT = "34ea9eb6eef921b59a55e6a435c7fc55c5727835";
export const ESP32S3_QEMU_MACHINE = "esp32s3";
export const DEFAULT_CORPUS_PATH = `${import.meta.dir}/fixtures/flexe-corpus.json`;
export const DEFAULT_FIXTURE_OBSERVATION_PATH = `${import.meta.dir}/fixtures/espressif-qemu-observation.fixture.json`;

export const REGISTER_NAMES = [
  "a0",
  "a1",
  "a2",
  "a3",
  "a4",
  "a5",
  "a6",
  "a7",
  "a8",
  "a9",
  "a10",
  "a11",
  "a12",
  "a13",
  "a14",
  "a15",
] as const;

export type RegisterName = (typeof REGISTER_NAMES)[number];
