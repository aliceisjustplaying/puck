// Canonical names for the host imports and firmware exports implemented by
// src/wasm.ts. The loader, ABI auditor, and executable WASI fixture derive
// their surface checks from these lists so policy cannot drift between them.

export const ENV_IMPORT_NAMES = [
  "sinf",
  "cosf",
  "atan2f",
  "sqrtf",
  "fabsf",
  "floorf",
  "fmodf",
  "powf",
  "expf",
  "js_log",
] as const;

export const WASI_PREVIEW1_IMPORT_NAMES = [
  "fd_close",
  "fd_seek",
  "fd_write",
  "proc_exit",
] as const;

export const REQUIRED_EMU_EXPORT_NAMES = [
  "emu_button",
  "emu_button_verdict",
  "emu_device",
  "emu_fb",
  "emu_init",
  "emu_push_count",
  "emu_push_h",
  "emu_push_w",
  "emu_push_x",
  "emu_push_y",
  "emu_sensor_event",
  "emu_tick",
  "emu_touch",
] as const;

export const OPTIONAL_APP_EXPORT_NAMES = ["emu_app_current", "emu_app_switch"] as const;

export const OPTIONAL_STORAGE_EXPORT_NAMES = [
  "emu_storage_buffer",
  "emu_storage_capacity",
  "emu_storage_size",
  "emu_storage_revision",
  "emu_storage_load",
] as const;

export const OPTIONAL_BATTERY_EXPORT_NAMES = ["emu_battery"] as const;

export const OPTIONAL_SOUND_EXPORT_NAMES = [
  "emu_sound_sample_rate",
  "emu_sound_play_seq",
  "emu_sound_stop_seq",
  "emu_sound_buffer",
  "emu_sound_frames",
] as const;

export const MEMORY_EXPORT_NAME = "memory" as const;
export const WASI_INITIALIZE_EXPORT_NAME = "_initialize" as const;
