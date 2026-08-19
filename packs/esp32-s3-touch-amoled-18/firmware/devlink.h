/*
 * devlink: the same line-oriented command protocol the RP2350 sibling pack
 * speaks (packs/rp2350-touch-amoled-18/tools/README-devlink.md), on this
 * board's native USB Serial/JTAG port, so the repository's differential
 * harness (harness/links/devlinkLink.ts) can drive real silicon here with
 * no second wire format to learn.
 *
 * WHY THE HOOK STRUCT IS NOT A COPY OF THE SIBLING'S. That one hands
 * devlink a `uint16_t *fb` and lets SHOT walk the framebuffer twice. This
 * board has no framebuffer at all - that is the entire point of this pack
 * (see AGENTS.md's memory model and firmware/runtime/app.h) - so there is
 * nothing here for a SHOT to walk. Instead the platform captures one frame
 * on request, at the moment each band is handed to the panel, into an
 * 8-bit greyscale buffer that is exactly the wire's own format. The three
 * shot_* hooks below are that arrangement; everything else is the sibling's
 * shape unchanged. See
 * docs/decisions/0002-devlink-over-usb-serial-jtag.md.
 *
 * Integration contract:
 *   - devlink_init() once, after display_init() succeeded and every hook
 *     function below exists.
 *   - devlink_poll() once per main-loop iteration, AFTER rtcore_tick(). It
 *     never blocks waiting for input. It is also where a SHOT requested on
 *     an earlier iteration is answered, which is why the ordering matters:
 *     the frame a SHOT captures is the one rtcore_tick() just drew.
 */
#ifndef DEVLINK_H
#define DEVLINK_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

// Symbolic PWR key gesture names, exactly the sibling pack's four. devlink
// stays hardware-blind: it does not know this board reads PWR through a
// TCA9554 IO expander rather than a PMIC, and does not need to. The mapping
// from these names to runtime_core.h's KEY_* bits belongs to whoever
// implements the hooks (main.c's "devlink wiring" section).
typedef enum {
    DEVLINK_KEY_PRESS,
    DEVLINK_KEY_LONG,
    DEVLINK_KEY_SHORT,
    DEVLINK_KEY_RELEASE,
} devlink_key_t;

typedef struct {
    int w, h; // panel dimensions in pixels, reported by PING and SHOT

    /* ---- screenshots ----------------------------------------------------
     * shot_arm() asks the platform to capture the NEXT complete frame.
     * shot_ready() reports whether the armed capture has finished (all
     * BAND_COUNT bands seen). shot_grey() returns w*h bytes, row-major, one
     * 8-bit grey level per pixel, in exactly the encoding the wire format
     * wants: the stored RGB565 pixel's six green bits shifted up by two,
     * which is what harness/links/devlinkLink.ts's greyToRGB() inverts.
     * shot_grey() may return NULL if the platform could not allocate the
     * capture buffer, which devlink answers as "ERR no framebuffer" - the
     * same reply the sibling gives for the same shaped failure. */
    void (*shot_arm)(void);
    bool (*shot_ready)(void);
    const uint8_t *(*shot_grey)(void);

    /* ---- touch and shake injection -------------------------------------- */
    void (*inject_down)(int x, int y);
    void (*inject_move)(int x, int y);
    void (*inject_up)(void);
    void (*erase)(void);

    /* ---- button injection ------------------------------------------------
     * These reach the runtime the same way a real press does (main.c's
     * rtcore_set_button/rtcore_set_button_verdict calls) but skip the chips
     * a real press goes through: the TCA9554 read for PWR, the GPIO0 sample
     * for BOOT. See the sibling's README-devlink.md, "What injection cannot
     * test" - the same caveat applies here, with different chips. */
    void (*inject_key)(devlink_key_t which);
    void (*inject_boot)(bool down);
    void (*inject_boot_click)(void);

    /* ---- app navigation --------------------------------------------------
     * This pack wires exactly one app slot (runtime_core.c's g_demoApp), so
     * app_current() always answers 0 and app_switch(0) re-enters it from a
     * rewound arena - which is what makes harness/hardwareSide.ts's reset()
     * step mean something here. Any other index is out of range. */
    int (*app_current)(void);
    const char *(*app_name)(int index);
    bool (*app_switch)(int index);
} devlink_hooks_t;

// Copies *hooks by value. Call once.
void devlink_init(const devlink_hooks_t *hooks);

// Call once per main-loop iteration, after rtcore_tick(). Never blocks on
// input. Emits a pending SHOT reply when the platform reports the capture
// complete.
void devlink_poll(void);

// How many SHOT replies had their body cut short because the host stopped
// draining the port mid-transfer (see devlink.c's DEVLINK_SHOT_BUDGET_US).
// main.c's profiler line reports this, so a truncated screenshot is never
// silently mistaken for a dead board - the sibling pack's reasoning,
// unchanged.
uint32_t devlink_dropped_shots(void);

#endif // DEVLINK_H
