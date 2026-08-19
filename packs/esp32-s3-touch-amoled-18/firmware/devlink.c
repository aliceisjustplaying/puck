/*
 * devlink implementation for this board. See devlink.h for the integration
 * contract and packs/rp2350-touch-amoled-18/tools/README-devlink.md for the
 * wire protocol, which this speaks unchanged so that
 * harness/links/devlinkLink.ts drives both boards with one adapter.
 *
 * THREE THINGS DIFFER FROM THE SIBLING'S devlink.c, all forced by this
 * board rather than chosen:
 *
 * 1. SHOT IS ANSWERED ONE FRAME LATE, NOT SYNCHRONOUSLY. The sibling walks
 *    a live framebuffer inside the command's own dispatch. There is no
 *    framebuffer here, so the picture only exists as it streams past
 *    plat_flush_band(). A SHOT therefore arms a capture and returns
 *    immediately; the reply goes out from the next devlink_poll(), after
 *    rtcore_tick() has painted the frame that capture was waiting for. A
 *    host sees nothing different: it sent SHOT and it reads a SHOT header
 *    back, tens of milliseconds later instead of immediately.
 *
 * 2. INPUT COMES OFF usb_serial_jtag_read_bytes(), NOT stdin. This was
 *    tried the other way first, and the board on the bench is what
 *    corrected it: with ESP-IDF v6.0.2's default (no-driver) USB
 *    Serial/JTAG console, read() on stdin CANNOT EVER RETURN DATA. Its
 *    implementation sizes the fetch from
 *    usb_serial_jtag_get_read_bytes_available(), which returns 0 flat
 *    whenever the driver is not installed
 *    (components/esp_driver_usb_serial_jtag/src/usb_serial_jtag.c), so a
 *    non-blocking read computes a fetch size of zero and returns without
 *    ever touching the RX FIFO. The visible symptom is not a silent
 *    devlink: it is the HOST blocking on write, because the OUT endpoint
 *    is never drained (a plain pyserial write to the board timed out).
 *    main.c therefore installs the usb_serial_jtag driver for its RX side
 *    and this file reads through it. Console WRITES deliberately stay on
 *    the no-driver path (main.c does not call
 *    usb_serial_jtag_vfs_use_driver): that path drops output after 50ms
 *    when no host is listening, where the driver's would block on a full
 *    ring, and a board that hangs when nobody is plugged in would be a
 *    serious regression bought for nothing. See gotchas.md.
 *
 * 3. OUTPUT IS WRITTEN A LINE AT A TIME, NOT A CHARACTER AT A TIME. The
 *    sibling putchar()s each base64 character straight into pico-sdk's
 *    stdio. Here every write crosses the VFS layer into the USB
 *    Serial/JTAG driver's ring buffer, so a per-character loop would pay
 *    that crossing tens of thousands of times for one screenshot. Output is
 *    accumulated into one line and written once.
 */
#include "devlink.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "driver/usb_serial_jtag.h"
#include "esp_timer.h"

#define DEVLINK_VERSION   1
#define DEVLINK_LINE_MAX  96  // as the sibling: longer lines are dropped and
                              // the parser resyncs on the next terminator
#define DEVLINK_B64_WRAP  76  // chars per base64 line, per the protocol

// Wall-clock budget for one SHOT reply's body, the same guard the sibling
// pack added after a non-draining host walked its watchdog into a reboot.
// The failure mode here is different in detail (the USB Serial/JTAG driver
// blocks on a full TX ring rather than falling through a per-character
// timeout) but identical in shape: a host that asks for a screenshot and
// then stops reading must not be able to stall the main loop indefinitely.
// Past the budget the remaining body is dropped and the reply still closes
// with END, which is exactly the "transfer was truncated" case the host
// already checks for by comparing the decoded byte count to the header's.
#define DEVLINK_SHOT_BUDGET_US 1500000

static devlink_hooks_t g_hooks;
static char g_line[DEVLINK_LINE_MAX];
static int g_lineLen = 0;

static uint32_t g_droppedShots = 0;

// Set by SHOT, serviced by the next devlink_poll() once the platform says
// the capture is complete. See this file's header comment (1).
static bool g_shotPending = false;

// Set by CHORD, serviced at the top of the NEXT devlink_poll(), so the tick
// that has to observe BOOT still held runs in between. Same mechanism, and
// the same reason, as the sibling's.
static bool g_chordReleasePending = false;

uint32_t devlink_dropped_shots(void) {
    return g_droppedShots;
}

void devlink_init(const devlink_hooks_t *hooks) {
    g_hooks = *hooks;
    g_lineLen = 0;
}

/* ---------------------------------------------------------------------
 * Output. One buffered line at a time (see this file's header comment, 3).
 * ------------------------------------------------------------------- */
static void dl_puts(const char *s) {
    fwrite(s, 1, strlen(s), stdout);
}

static void dl_flush(void) {
    fflush(stdout);
}

// EVERY REPLY STARTS BY ENDING WHATEVER LINE WAS IN FLIGHT. Measured on the
// bench, and it cost an afternoon: the console's own writer drops characters
// once 50ms have passed since the last one the host accepted
// (usb_serial_jtag_tx_char_no_driver's TX_FLUSH_TIMEOUT_US), which is exactly
// the state a board sitting unattached is in. So the first moment a devlink
// client opens the port, the log line in flight loses its tail and the reply
// lands welded onto the remnant:
//
//   I (434687) imu: accel peak residual 0.02 m/s2 over the last secoOK devlink 1 368 448
//
// A host that matches the reply's SHAPE - which is the discipline this
// protocol asks of every client, for good reasons the sibling pack's
// README-devlink.md sets out at length - correctly refuses that line, and the
// command times out. The board looks dead while answering perfectly.
//
// Two bytes fix it: open every reply with a line terminator, so a reply
// always begins a line of its own no matter what was cut short before it. The
// cost is a blank line in an otherwise clean stream, which every client
// already discards as noise. This does not, and cannot, protect a reply whose
// OWN characters are dropped; that still shows up as a timeout, and the next
// command works.
static void dl_reply_begin(void) {
    dl_puts("\r\n");
}

/* ---------------------------------------------------------------------
 * Screenshot: run-length encoding + base64 over the platform's greyscale
 * capture. No colour conversion happens here, unlike the sibling: the
 * capture buffer is already one byte per pixel in the wire's own encoding
 * (devlink.h), because the only moment this board's pixels exist is when a
 * band goes out, and converting them there costs one pass instead of two.
 * ------------------------------------------------------------------- */
static const char devlink_b64_table[] =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

typedef struct {
    uint8_t buf[3];
    int bufLen;
    char line[DEVLINK_B64_WRAP + 3]; // wrap + "\r\n" + NUL
    int lineCol;
    int64_t deadlineUs;
    bool truncated;
} devlink_b64_stream_t;

static void devlink_b64_emit_char(devlink_b64_stream_t *s, char c) {
    s->line[s->lineCol++] = c;
    if (s->lineCol >= DEVLINK_B64_WRAP) {
        s->line[s->lineCol++] = '\r';
        s->line[s->lineCol++] = '\n';
        s->line[s->lineCol] = '\0';
        dl_puts(s->line);
        s->lineCol = 0;
    }
}

static void devlink_b64_flush_group(devlink_b64_stream_t *s) {
    if (s->bufLen == 0) return;
    if (s->truncated) {
        s->bufLen = 0;
        return;
    }
    if (esp_timer_get_time() > s->deadlineUs) {
        s->truncated = true;
        g_droppedShots++;
        s->bufLen = 0;
        return;
    }
    uint32_t n = ((uint32_t)s->buf[0] << 16) |
                 ((uint32_t)(s->bufLen > 1 ? s->buf[1] : 0) << 8) |
                 (uint32_t)(s->bufLen > 2 ? s->buf[2] : 0);
    devlink_b64_emit_char(s, devlink_b64_table[(n >> 18) & 0x3F]);
    devlink_b64_emit_char(s, devlink_b64_table[(n >> 12) & 0x3F]);
    devlink_b64_emit_char(s, s->bufLen > 1 ? devlink_b64_table[(n >> 6) & 0x3F] : '=');
    devlink_b64_emit_char(s, s->bufLen > 2 ? devlink_b64_table[n & 0x3F] : '=');
    s->bufLen = 0;
}

static void devlink_b64_push_byte(devlink_b64_stream_t *s, uint8_t b) {
    s->buf[s->bufLen++] = b;
    if (s->bufLen == 3) devlink_b64_flush_group(s);
}

// Walks the greyscale capture as (value, count) pairs, count clamped to
// 1..255, calling emit() for each. Used twice: once to total the byte count
// the SHOT header has to promise up front, once to stream it. Two passes
// over 165KB of PSRAM are cheaper than buffering the encoded stream.
typedef void (*devlink_rle_emit_fn)(uint8_t value, uint8_t count, void *ctx);

static void devlink_rle_walk(const uint8_t *grey, int n, devlink_rle_emit_fn emit, void *ctx) {
    if (n <= 0) return;
    uint8_t cur = grey[0];
    int runLen = 1;
    for (int i = 1; i < n; i++) {
        uint8_t g = grey[i];
        if (g == cur && runLen < 255) {
            runLen++;
        } else {
            emit(cur, (uint8_t)runLen, ctx);
            cur = g;
            runLen = 1;
        }
    }
    emit(cur, (uint8_t)runLen, ctx);
}

static void devlink_rle_count_cb(uint8_t value, uint8_t count, void *ctx) {
    (void)value;
    (void)count;
    *(uint32_t *)ctx += 2;
}

static void devlink_rle_emit_b64_cb(uint8_t value, uint8_t count, void *ctx) {
    devlink_b64_stream_t *s = (devlink_b64_stream_t *)ctx;
    devlink_b64_push_byte(s, value);
    devlink_b64_push_byte(s, count);
}

static void devlink_send_shot(void) {
    dl_reply_begin();
    const uint8_t *grey = g_hooks.shot_grey ? g_hooks.shot_grey() : NULL;
    if (grey == NULL || g_hooks.w <= 0 || g_hooks.h <= 0) {
        dl_puts("ERR no framebuffer\r\n");
        dl_flush();
        return;
    }
    const int n = g_hooks.w * g_hooks.h;

    uint32_t rleBytes = 0;
    devlink_rle_walk(grey, n, devlink_rle_count_cb, &rleBytes);

    char header[48];
    snprintf(header, sizeof header, "SHOT %d %d %lu\r\n", g_hooks.w, g_hooks.h,
             (unsigned long)rleBytes);
    dl_puts(header);

    devlink_b64_stream_t s;
    s.bufLen = 0;
    s.lineCol = 0;
    s.deadlineUs = esp_timer_get_time() + DEVLINK_SHOT_BUDGET_US;
    s.truncated = false;
    devlink_rle_walk(grey, n, devlink_rle_emit_b64_cb, &s);
    devlink_b64_flush_group(&s); // final partial group, if any
    if (s.lineCol != 0) {
        s.line[s.lineCol++] = '\r';
        s.line[s.lineCol++] = '\n';
        s.line[s.lineCol] = '\0';
        dl_puts(s.line);
    }
    dl_puts("END\r\n");
    dl_flush();
}

/* ---------------------------------------------------------------------
 * Line protocol. Parsing helpers are the sibling's, unchanged: the wire
 * format is the same wire format, so the parser that reads it should be
 * the same parser.
 * ------------------------------------------------------------------- */
static int devlink_parse_two_ints(const char *s, int *a, int *b) {
    while (*s == ' ') s++;
    char *end;
    long va = strtol(s, &end, 10);
    if (end == s) return 0;
    s = end;
    while (*s == ' ') s++;
    long vb = strtol(s, &end, 10);
    if (end == s) return 1;
    *a = (int)va;
    *b = (int)vb;
    return 2;
}

static bool devlink_parse_one_int(const char *s, int *a) {
    while (*s == ' ') s++;
    char *end;
    long v = strtol(s, &end, 10);
    if (end == s) return false;
    *a = (int)v;
    return true;
}

static bool devlink_word_is(const char *s, const char *word) {
    while (*s == ' ') s++;
    size_t i = 0;
    for (; word[i]; i++) {
        if (toupper((unsigned char)s[i]) != (unsigned char)word[i]) return false;
    }
    char after = s[i];
    return after == '\0' || after == ' ';
}

static void devlink_dispatch(char *line) {
    char *p = line;
    while (*p == ' ') p++;
    char *cmdStart = p;
    while (*p && *p != ' ') p++;
    size_t cmdLen = (size_t)(p - cmdStart);

    if (*p) *p++ = '\0';
    char *args = p;
    while (*args == ' ') args++;

    if (cmdLen == 0) return; // blank line: ignore silently

    // Before any reply byte, including SHOT's (which is emitted later, from
    // devlink_poll(), and opens itself the same way).
    dl_reply_begin();

    char cmd[16];
    if (cmdLen >= sizeof(cmd)) {
        printf("ERR unknown %s\r\n", cmdStart);
        dl_flush();
        return;
    }
    for (size_t i = 0; i < cmdLen; i++) cmd[i] = (char)toupper((unsigned char)cmdStart[i]);
    cmd[cmdLen] = '\0';

    if (strcmp(cmd, "PING") == 0) {
        printf("OK devlink %d %d %d\r\n", DEVLINK_VERSION, g_hooks.w, g_hooks.h);
    } else if (strcmp(cmd, "SHOT") == 0) {
        // Armed here, answered from devlink_poll() once the capture lands.
        // Nothing is printed now: a host waiting for a "SHOT w h n" header
        // must not see one until the pixels behind it actually exist.
        if (g_hooks.shot_arm) g_hooks.shot_arm();
        g_shotPending = true;
        return; // no flush: nothing was written
    } else if (strcmp(cmd, "DOWN") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); dl_flush(); return; }
        if (g_hooks.inject_down) g_hooks.inject_down(x, y);
        printf("OK\r\n");
    } else if (strcmp(cmd, "MOVE") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); dl_flush(); return; }
        if (g_hooks.inject_move) g_hooks.inject_move(x, y);
        printf("OK\r\n");
    } else if (strcmp(cmd, "UP") == 0) {
        if (g_hooks.inject_up) g_hooks.inject_up();
        printf("OK\r\n");
    } else if (strcmp(cmd, "TAP") == 0) {
        int x, y;
        if (devlink_parse_two_ints(args, &x, &y) != 2) { printf("ERR args\r\n"); dl_flush(); return; }
        if (g_hooks.inject_down) g_hooks.inject_down(x, y);
        if (g_hooks.inject_up) g_hooks.inject_up();
        printf("OK\r\n");
    } else if (strcmp(cmd, "ERASE") == 0) {
        if (g_hooks.erase) g_hooks.erase();
        printf("OK\r\n");
    } else if (strcmp(cmd, "KEY") == 0) {
        devlink_key_t which;
        if (devlink_word_is(args, "PRESS")) which = DEVLINK_KEY_PRESS;
        else if (devlink_word_is(args, "LONG")) which = DEVLINK_KEY_LONG;
        else if (devlink_word_is(args, "SHORT")) which = DEVLINK_KEY_SHORT;
        else if (devlink_word_is(args, "RELEASE")) which = DEVLINK_KEY_RELEASE;
        else { printf("ERR args\r\n"); dl_flush(); return; }
        if (g_hooks.inject_key) g_hooks.inject_key(which);
        printf("OK\r\n");
    } else if (strcmp(cmd, "BOOT") == 0) {
        if (devlink_word_is(args, "DOWN")) {
            if (g_hooks.inject_boot) g_hooks.inject_boot(true);
        } else if (devlink_word_is(args, "UP")) {
            if (g_hooks.inject_boot) g_hooks.inject_boot(false);
        } else if (devlink_word_is(args, "CLICK")) {
            if (g_hooks.inject_boot_click) g_hooks.inject_boot_click();
        } else {
            printf("ERR args\r\n");
            dl_flush();
            return;
        }
        printf("OK\r\n");
    } else if (strcmp(cmd, "CHORD") == 0) {
        // Composed from BOOT and KEY, exactly as the sibling does, and
        // deliberately no more. This pack has one app and no menu, so
        // nothing on this board reacts to the chord today; the command
        // exists so the protocol is the protocol, and so a trace recorded
        // against either pack replays against either board.
        if (g_hooks.inject_boot) g_hooks.inject_boot(true);
        if (g_hooks.inject_key) g_hooks.inject_key(DEVLINK_KEY_LONG);
        g_chordReleasePending = true;
        printf("OK\r\n");
    } else if (strcmp(cmd, "APP") == 0) {
        int idx = g_hooks.app_current ? g_hooks.app_current() : 0;
        const char *name = g_hooks.app_name ? g_hooks.app_name(idx) : NULL;
        printf("APP %d %s\r\n", idx, name ? name : "?");
    } else if (strcmp(cmd, "SWITCH") == 0) {
        int idx;
        if (!devlink_parse_one_int(args, &idx)) { printf("ERR args\r\n"); dl_flush(); return; }
        bool ok = g_hooks.app_switch ? g_hooks.app_switch(idx) : false;
        printf(ok ? "OK\r\n" : "ERR range\r\n");
    } else if (strcmp(cmd, "TUNE") == 0) {
        // The protocol carries TUNE; this pack declares no tunables, which
        // the sibling's own wire format already has an answer for. Saying
        // that, rather than "ERR unknown TUNE", keeps a client able to ask
        // both boards the same question and read the difference.
        printf("ERR no tunables\r\n");
    } else {
        printf("ERR unknown %s\r\n", cmd);
    }
    dl_flush();
}

void devlink_poll(void) {
    // Release BOOT from a CHORD one iteration after it was asserted, before
    // anything else, so it lands strictly after the rtcore_tick() that had
    // to see BOOT still held.
    if (g_chordReleasePending) {
        g_chordReleasePending = false;
        if (g_hooks.inject_boot) g_hooks.inject_boot(false);
    }

    // A SHOT armed on an earlier iteration, now that the frame it was
    // waiting for has been painted.
    if (g_shotPending && g_hooks.shot_ready && g_hooks.shot_ready()) {
        g_shotPending = false;
        devlink_send_shot();
    }

    for (;;) {
        uint8_t chunk[64];
        int n = usb_serial_jtag_read_bytes(chunk, sizeof chunk, 0);
        if (n <= 0) return; // nothing queued right now

        for (int i = 0; i < n; i++) {
            char c = (char)chunk[i];
            if (c == '\n' || c == '\r') {
                if (g_lineLen > 0) {
                    g_line[g_lineLen] = '\0';
                    g_lineLen = 0;
                    devlink_dispatch(g_line);
                }
                continue;
            }
            if (g_lineLen < DEVLINK_LINE_MAX - 1) {
                g_line[g_lineLen++] = c;
            } else {
                // Overlong line: drop it and resync on the next terminator
                // rather than acting on a truncated command.
                g_lineLen = 0;
            }
        }
    }
}
