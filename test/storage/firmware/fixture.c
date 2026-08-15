#include "emu_abi.h"

#include <stdint.h>

static uint16_t framebuffer[4];
static uint8_t storage_buffer[16];
static uint32_t storage_revision;
static uint8_t durable_value;
static int pending_button;
static int battery_dirty;
static int battery_percent;
static int battery_charging;
static int battery_external;
static int push_count;

static const char descriptor[] =
    "{\"name\":\"storage-battery-fixture\","
    "\"panel\":{\"w\":2,\"h\":2,\"format\":\"rgb565\"},"
    "\"storage\":{\"id\":\"org.puck.test.storage\",\"snapshotVersion\":1,\"maxBytes\":16},"
    "\"battery\":true}";

static void refresh_storage(void) {
  storage_buffer[0] = 'P';
  storage_buffer[1] = 'U';
  storage_buffer[2] = 'K';
  storage_buffer[3] = '1';
  storage_buffer[4] = 1;
  storage_buffer[5] = durable_value;
  storage_buffer[6] = storage_buffer[0] ^ storage_buffer[1] ^ storage_buffer[2] ^
                      storage_buffer[3] ^ storage_buffer[4] ^ storage_buffer[5];
}

int emu_device(void) { return (int)(uintptr_t)descriptor; }

int emu_init(void) {
  durable_value = 10;
  storage_revision = 0;
  pending_button = 0;
  battery_dirty = 0;
  battery_percent = -1;
  battery_charging = 0;
  battery_external = 0;
  framebuffer[0] = durable_value;
  framebuffer[1] = 0;
  framebuffer[2] = 0;
  framebuffer[3] = 0;
  push_count = 0;
  refresh_storage();
  return 1;
}

void emu_tick(uint32_t now_ms) {
  (void)now_ms;
  push_count = 0;
  if (pending_button) {
    pending_button = 0;
    durable_value++;
    framebuffer[0] = durable_value;
    storage_revision++;
    refresh_storage();
    push_count = 1;
  }
  if (battery_dirty) {
    battery_dirty = 0;
    framebuffer[1] = (uint16_t)((battery_percent + 1) | (battery_charging << 8) |
                                (battery_external << 9));
    push_count = 1;
  }
}

int emu_fb(void) { return (int)(uintptr_t)framebuffer; }
int emu_push_count(void) { return push_count; }
int emu_push_x(int i) { (void)i; return 0; }
int emu_push_y(int i) { (void)i; return 0; }
int emu_push_w(int i) { (void)i; return 2; }
int emu_push_h(int i) { (void)i; return 2; }
void emu_touch(int down, int x, int y) { (void)down; (void)x; (void)y; }
void emu_button(int index, int down) { if (index == 0 && down) pending_button = 1; }
void emu_button_verdict(int index, int is_long) { (void)index; (void)is_long; }
void emu_sensor_event(int index) { (void)index; }

void emu_battery(int percent, int charging, int external) {
  battery_percent = percent;
  battery_charging = charging;
  battery_external = external;
  battery_dirty = 1;
}

int emu_storage_buffer(void) { return (int)(uintptr_t)storage_buffer; }
uint32_t emu_storage_capacity(void) { return sizeof(storage_buffer); }
uint32_t emu_storage_size(void) { return 7; }
uint32_t emu_storage_revision(void) { return storage_revision; }
int emu_storage_load(uint32_t length) {
  if (length == 0) return EMU_STORAGE_EMPTY;
  if (length != 7 || storage_buffer[0] != 'P' || storage_buffer[1] != 'U' ||
      storage_buffer[2] != 'K' || storage_buffer[3] != '1') {
    refresh_storage();
    return EMU_STORAGE_CORRUPT;
  }
  if (storage_buffer[4] != 1) {
    refresh_storage();
    return EMU_STORAGE_INCOMPATIBLE;
  }
  uint8_t checksum = storage_buffer[0] ^ storage_buffer[1] ^ storage_buffer[2] ^
                     storage_buffer[3] ^ storage_buffer[4] ^ storage_buffer[5];
  if (storage_buffer[6] != checksum) {
    refresh_storage();
    return EMU_STORAGE_CORRUPT;
  }
  durable_value = storage_buffer[5];
  framebuffer[0] = durable_value;
  refresh_storage();
  return EMU_STORAGE_ACCEPTED;
}
