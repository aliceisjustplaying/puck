/*
 * app: what an app is, and what the runtime promises it, on this pack.
 *
 * THE MEMORY MODEL, AND WHY IT SHAPES THIS HEADER. This board has 368x448
 * pixels of RGB565 panel, which is 322KB as a full frame - too big to keep
 * twice in the ESP32-S3's 512KB of internal SRAM alongside everything else
 * the app and the IDF stacks need, and PSRAM is out because the CPU writing
 * pixels and the DMA engine reading them would fight over the same external
 * bus (see the pack's AGENTS.md and esp32-fluidbox/fluidbox/README.md,
 * section 2, "No framebuffer"). So there IS no framebuffer here, full stop,
 * not on the board and not in this header's contract. The panel is painted
 * in 16 horizontal bands of 28 rows, each a 20KB RGB565 buffer, and the
 * runtime hands an app exactly one band at a time through draw_band() below.
 * This is the entire reason this app_t differs from the sibling RP2350
 * pack's: that board's 520KB SRAM fits a full 330KB framebuffer, so its apps
 * draw into one persistent buffer and name a dirty rectangle. An app written
 * against that contract cannot run here unmodified, and the reverse is
 * equally true - see this pack's AGENTS.md before assuming the two are
 * interchangeable.
 *
 * THE CONTRACT, restated because it is easy to get backwards: every frame,
 * for every app on this board, the runtime calls tick() exactly once (update
 * state only, no drawing), then calls draw_band() once for EVERY band, 0
 * through 15, in order. There is no persistent framebuffer anywhere in this
 * pack, on the board or in the emulator: a band buffer arrives with
 * UNDEFINED content (real hardware reuses two DMA buffers in rotation, so a
 * fresh band may hold whatever the panel was showing several frames ago, in
 * a different band's rows) and draw_band MUST write every pixel of the
 * rectangle it was handed, every time, with no "only redraw what changed"
 * shortcut - there is nothing to diff against. See gfx_band.h for the
 * drawing helpers that make this tractable: gfxb_fill() covers a band in one
 * call, and gfxb_fill_rect() clips a full-screen rectangle to whichever band
 * is currently being painted.
 */
#ifndef APP_H
#define APP_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/* ---- the arena -----------------------------------------------------------
 *
 * App state lives here, not in file-scope statics, for the same reason the
 * RP2350 sibling's app.h gives: a static buffer's cost is invisible until
 * the link fails, and an arena makes it one number in one place. This pack
 * ships a single reference app (device.json declares no "apps" array, so
 * there is no switching and no menu to reclaim memory for), which is why the
 * arena here is smaller than the sibling's 64KB and is never reset: enter()
 * runs exactly once, at boot, and the arena simply accumulates whatever that
 * one app asks for. If a second app is ever added to this pack, revisit this
 * the same way runtime_core.c's own header comment describes: an app table,
 * a switch function, and an arena reset on switch, copied from the sibling.
 */
#define APP_ARENA_BYTES 8192

// Allocates from the arena, zeroed. Only legal inside enter().
//
// It never returns NULL, for the same reason the sibling pack's app_alloc()
// does not: running out of arena is a build-time bug (the one app asked for
// more than APP_ARENA_BYTES), not a runtime condition, and handing NULL to a
// caller that dereferences it unchecked would turn a precise, nameable
// failure into a null-dereference somewhere else entirely. See
// runtime_core.c's arena_overflow_trap() for what happens instead.
void *app_alloc(size_t bytes);

// Zeroed convenience form, which is what an app's state struct always wants.
#define APP_STATE(type) ((type *)app_alloc(sizeof(type)))

/* ---- input the runtime hands to the app ----------------------------------
 *
 * Same shape as the RP2350 sibling's app_frame_t, deliberately: an app
 * ported between the two packs' boards should only have to rewrite its
 * drawing (framebuffer rectangle vs. band), not its input handling.
 */
typedef struct {
    // Touch, already clamped to the panel and resolved into a simple
    // down/moved/up shape.
    bool     touchDown;      // a finger is on the glass right now
    bool     touchPressed;   // it went down this frame
    bool     touchReleased;  // it came up this frame
    int      touchX, touchY; // panel coordinates, valid while touchDown

    // PWR key bits the runtime did not consume. device.json declares
    // longPressMs for pwr, so the verdict (KEY_SHORT vs KEY_LONG) is decided
    // upstream (by the board's own hold-timing, mirrored by the emulator's
    // longPressMs handling) and delivered here as a bit, exactly the shape
    // emu_abi.h's emu_button_verdict() documents. See runtime_core.h for the
    // KEY_* bit values.
    uint8_t  key;

    // True on the frame BOOT was released. This board's BOOT is a plain
    // GPIO0 strap button (see main/main.c), not a borrowed flash chip select
    // like the RP2350 sibling's, so there is no equivalent sampling-rate
    // caveat here.
    bool     bootClicked;

    // True on the frame an accepted shake was reported. Unlike the sibling
    // pack, this is delivered unconditionally: with one app and no drawing
    // surface to protect from an unwanted erase, there is nothing here that
    // needs shake gated behind an opt-in flag.
    bool     shaken;

    uint32_t nowMs;
    uint32_t dtMs;           // since the previous tick, clamped
} app_frame_t;

/* ---- the app ---------------------------------------------------------- */

typedef struct {
    // Shown in logs on the board; nothing here reads it back for a menu,
    // since this pack ships no app-switching concept.
    const char *name;

    // Called once, at boot. Allocate state from the arena here; nothing else
    // is a legal place to call app_alloc().
    void (*enter)(void);

    // Called once per frame, before any band is drawn. Update state only -
    // there is no framebuffer to draw into yet, and won't be one until
    // draw_band() runs for whichever band a pixel belongs to.
    void (*tick)(const app_frame_t *f);

    // Called once per frame for EVERY band, 0 through 15, in order. buf
    // holds PANEL_W * rows RGB565 pixels (panel byte order - see gfx_band.h)
    // with UNDEFINED prior content: this function must write every pixel of
    // it, every call. y0 is the band's first row in full-screen (panel)
    // coordinates, rows is always BAND_ROWS (28) on this pack. Use
    // gfxb_fill()/gfxb_fill_rect() (gfx_band.h) rather than indexing buf by
    // hand, so the panel's byte-swapped pixel format and the full-screen ->
    // band coordinate clip both live in one place.
    void (*draw_band)(int band, uint16_t *buf, int y0, int rows);

    // Optional. Called before the arena would be reset - never actually
    // invoked by this pack today, since there is no second app to switch
    // to, but kept for symmetry with the sibling pack's app_t and so a
    // future second app costs nothing more than adding the switch machinery
    // runtime_core.c's header comment describes.
    void (*leave)(void);
} app_t;

#endif // APP_H
