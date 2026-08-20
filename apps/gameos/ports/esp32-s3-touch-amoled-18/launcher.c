// launcher.c -- this port's own minimal picker: three cards (GUNSHIP,
// LUCKY 7, GOLF), tap to launch. NO LONGER byte-for-byte the same file as
// this app's rp2350 port's own ports/rp2350-touch-amoled-18/launcher.c
// (which still ships two games only, GOLF being esp32-only - see this
// port's NOTICE.md and README.md) - that fork happened here, adding a
// third card and re-laying out the vertical geometry so all three stay
// >=40 render px tall (the same "no touch row under about 40 render px"
// rule docs/input-and-ux.md states), which moved the first two cards'
// pixel positions and is why apps/gameos/traces/gameos-demo.trace.json's
// own launcher-tap coordinates were re-recorded alongside this change (see
// that trace's own recordedAt). Still depends on nothing beyond gos.h's
// public primitives (no ABI-specific type or call anywhere in it). NOT a
// port of esp32-gameos's own gos_shell/shell.c (694 lines: a Wii-menu
// launcher with a settings screen, a pause overlay and a first-run tilt-
// calibration wizard) - see this port's README.md for why that whole shell
// was not attempted here either.
// Two rules docs/input-and-ux.md states plainly enough to be worth
// repeating here: launch on RELEASE, never on press ("it launches gunship
// by default" was a real reported bug in the donor's own history), and no
// touch row under about 40 render px.
#include "../../reference/esp32-gameos/gos.h"

#define CARD_X       10
#define CARD_W       164
#define CARD_GUN_Y0   36
#define CARD_GUN_Y1   80
#define CARD_SLOTS_Y0 92
#define CARD_SLOTS_Y1 136
#define CARD_GOLF_Y0  148
#define CARD_GOLF_Y1  192

typedef struct {
    bool was;
    int16_t ox, oy, lx, ly;
} launcher_t;

static launcher_t s_launcher;

void launcher_reset(void) {
    s_launcher = (launcher_t){ 0 };
}

static int iabs(int v) { return v < 0 ? -v : v; }

// Returns -1 (stay on the launcher), 0 (launch GUNSHIP), 1 (launch LUCKY 7),
// 2 (launch GOLF).
int launcher_update(const gos_input_t *in) {
    int pick = -1;
    if (in->touching) {
        if (!s_launcher.was) { s_launcher.ox = s_launcher.lx = in->touch.x; s_launcher.oy = s_launcher.ly = in->touch.y; }
        else { s_launcher.lx = in->touch.x; s_launcher.ly = in->touch.y; }
    } else if (s_launcher.was) {
        int dx = s_launcher.lx - s_launcher.ox, dy = s_launcher.ly - s_launcher.oy;
        if (iabs(dx) < 12 && iabs(dy) < 12) { // a tap, not a drag
            if (s_launcher.ox >= CARD_X && s_launcher.ox <= CARD_X + CARD_W) {
                if (s_launcher.oy >= CARD_GUN_Y0 && s_launcher.oy <= CARD_GUN_Y1) pick = 0;
                else if (s_launcher.oy >= CARD_SLOTS_Y0 && s_launcher.oy <= CARD_SLOTS_Y1) pick = 1;
                else if (s_launcher.oy >= CARD_GOLF_Y0 && s_launcher.oy <= CARD_GOLF_Y1) pick = 2;
            }
        }
    }
    s_launcher.was = in->touching;
    return pick;
}

static void draw_card(int y0, int y1, gos_color_t fill, gos_color_t accent, const char *title, const char *sub) {
    gos_rect_t r = { CARD_X, (int16_t)y0, CARD_W, (int16_t)(y1 - y0) };
    gos_gfx_rect_fill(r, fill);
    gos_gfx_rect(r, accent);
    gos_gfx_rect((gos_rect_t){ (int16_t)(r.x + 1), (int16_t)(r.y + 1), (int16_t)(r.w - 2), (int16_t)(r.h - 2) }, accent);
    int tw = gos_gfx_text_w(1, title);
    gos_gfx_text(1, CARD_X + (CARD_W - tw) / 2, (int16_t)(y0 + (y1 - y0) / 2 - 14), GOS_WHITE, "%s", title);
    int sw = gos_gfx_text_w(0, sub);
    gos_gfx_text(0, CARD_X + (CARD_W - sw) / 2, (int16_t)(y0 + (y1 - y0) / 2 + 8), accent, "%s", sub);
}

void launcher_render(void) {
    gos_gfx_clear(GOS_NAVY);
    int tw = gos_gfx_text_w(1, "GAMEOS");
    gos_gfx_text(1, (GOS_SCREEN_W - tw) / 2, 12, GOS_WHITE, "GAMEOS");
    draw_card(CARD_GUN_Y0, CARD_GUN_Y1, GOS_DARKGRAY, GOS_ORANGE, "GUNSHIP", "TILT + TOUCH FIRE");
    draw_card(CARD_SLOTS_Y0, CARD_SLOTS_Y1, GOS_DARKGRAY, GOS_AMBER, "LUCKY 7", "DRAG DOWN TO PULL");
    draw_card(CARD_GOLF_Y0, CARD_GOLF_Y1, GOS_DARKGRAY, GOS_GREEN, "GOLF", "SWING TO PLAY");
    gos_gfx_text(0, 4, 200, GOS_GRAY, "IN GAME: SWIPE TOP DOWN = EXIT");
    const char *hint = "TAP A CARD TO LAUNCH";
    int hw = gos_gfx_text_w(0, hint);
    gos_gfx_text(0, (GOS_SCREEN_W - hw) / 2, 210, GOS_LTGRAY, "%s", hint);
}
