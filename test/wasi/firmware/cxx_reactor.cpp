#include <array>
#include <cstddef>
#include <cstdint>
#include <cstdio>
#include <limits>
#include <vector>

namespace {

constexpr int kWidth = 4;
constexpr int kHeight = 4;
constexpr std::size_t kPixelCount = static_cast<std::size_t>(kWidth * kHeight);
constexpr std::size_t kButtonCount = 2;
constexpr std::size_t kSensorCount = 1;
constexpr std::size_t kMaxPushes = 2;
constexpr char kDeviceJson[] =
    "{\"name\":\"cxx-reactor\",\"panel\":{\"w\":4,\"h\":4,\"format\":\"rgb565\"},"
    "\"buttons\":[{\"id\":\"a\",\"label\":\"A\",\"edge\":\"right\",\"at\":0.5},"
    "{\"id\":\"b\",\"label\":\"B\",\"edge\":\"left\",\"at\":0.5}],"
    "\"touch\":{\"points\":1},\"sensors\":[{\"id\":\"event\",\"kind\":\"event\"}]}";
constexpr std::array<std::uint16_t, 4> kColors{0xFFFFU, 0xF800U, 0x07E0U, 0x001FU};

struct TouchReport {
  int contacts = 0;
  int x = 0;
  int y = 0;
  bool changed = false;
};

struct ButtonReport {
  bool down = false;
  bool changed = false;
};

struct VerdictReport {
  bool is_long = false;
  bool changed = false;
};

struct RefreshRect {
  int x = 0;
  int y = 0;
  int width = 0;
  int height = 0;
};

// This namespace-scope vector has dynamic initialization. The fixture's
// emu_init() checks its contents, making the loader's _initialize call
// load-bearing rather than merely present in the export table.
std::vector<std::uint16_t> startup_probe(1, kColors[0]);

std::vector<std::uint16_t> framebuffer;
TouchReport pending_touch;
std::array<ButtonReport, kButtonCount> pending_buttons;
std::array<VerdictReport, kButtonCount> pending_verdicts;
std::array<std::uint32_t, kSensorCount> pending_sensor_events;
std::array<RefreshRect, kMaxPushes> pushes;
std::size_t push_count = 0;
bool initialized = false;

bool valid_index(int index, std::size_t size) {
  return index >= 0 && static_cast<std::size_t>(index) < size;
}

void push(int x, int y, int width, int height) {
  if (push_count < pushes.size()) pushes[push_count++] = {x, y, width, height};
}

const RefreshRect& get_push(int index) {
  static constexpr RefreshRect empty{};
  if (!valid_index(index, push_count)) return empty;
  return pushes[static_cast<std::size_t>(index)];
}

void clear_transient_input() {
  pending_touch.changed = false;
  for (auto& button : pending_buttons) button.changed = false;
  for (auto& verdict : pending_verdicts) verdict.changed = false;
  pending_sensor_events.fill(0);
}

int pointer_to_offset(const void* pointer) {
  return static_cast<int>(reinterpret_cast<std::uintptr_t>(pointer));
}

}  // namespace

extern "C" {

int emu_device() { return pointer_to_offset(kDeviceJson); }

int emu_init() {
  if (startup_probe.size() != 1 || startup_probe[0] != kColors[0]) return 0;
  framebuffer.assign(kPixelCount, kColors[0]);
  pending_touch = {};
  pending_buttons = {};
  pending_verdicts = {};
  pending_sensor_events = {};
  push_count = 0;
  initialized = true;
  std::fprintf(stderr, "cxx reactor ready\n");
  return 1;
}

void emu_tick(std::uint32_t now_ms) {
  if (!initialized) return;
  push_count = 0;
  const TouchReport touch = pending_touch;
  const auto buttons = pending_buttons;
  const auto verdicts = pending_verdicts;
  const auto sensor_events = pending_sensor_events;
  clear_transient_input();

  if (touch.changed && touch.contacts != 0 && touch.x >= 0 && touch.x < kWidth &&
      touch.y >= 0 && touch.y < kHeight) {
    framebuffer[static_cast<std::size_t>(touch.y * kWidth + touch.x)] =
        kColors[static_cast<std::size_t>(now_ms) % kColors.size()];
    push(touch.x, touch.y, 1, 1);
  }
  if (buttons[0].changed) {
    framebuffer[0] = buttons[0].down ? 0xF800U : 0xFFFFU;
    push(0, 0, 1, 1);
  }
  if (verdicts[1].changed) {
    framebuffer[1] = verdicts[1].is_long ? 0x07E0U : 0xFFFFU;
    push(1, 0, 1, 1);
  }
  if (sensor_events[0] != 0) {
    framebuffer[2] = static_cast<std::uint16_t>(sensor_events[0]);
    push(2, 0, 1, 1);
  }
}

int emu_fb() { return initialized ? pointer_to_offset(framebuffer.data()) : 0; }
int emu_push_count() { return initialized ? static_cast<int>(push_count) : 0; }
int emu_push_x(int index) { return get_push(index).x; }
int emu_push_y(int index) { return get_push(index).y; }
int emu_push_w(int index) { return get_push(index).width; }
int emu_push_h(int index) { return get_push(index).height; }

void emu_touch(int down, int x, int y) {
  pending_touch = {.contacts = down != 0 ? 1 : 0, .x = x, .y = y, .changed = true};
}

void emu_button(int index, int down) {
  if (!valid_index(index, pending_buttons.size())) return;
  auto& button = pending_buttons[static_cast<std::size_t>(index)];
  button.down = down != 0;
  button.changed = true;
}

void emu_button_verdict(int index, int is_long) {
  if (!valid_index(index, pending_verdicts.size())) return;
  auto& verdict = pending_verdicts[static_cast<std::size_t>(index)];
  verdict.is_long = is_long != 0;
  verdict.changed = true;
}

void emu_sensor_event(int index) {
  if (!valid_index(index, pending_sensor_events.size())) return;
  auto& count = pending_sensor_events[static_cast<std::size_t>(index)];
  if (count != std::numeric_limits<std::uint32_t>::max()) ++count;
}

}  // extern "C"
