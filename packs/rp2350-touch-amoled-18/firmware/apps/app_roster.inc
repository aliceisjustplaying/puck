/* app_roster.inc: this firmware's app layer, as the runtime sees it.
 *
 * INCLUDED, not compiled: firmware/runtime/runtime_core.c pulls this in at the
 * point where its app table used to be hardcoded. That file is a device pack
 * source (docs/convention/device-pack.md), shared verbatim with every firmware
 * built on this board; this file is the ONE thing each of those firmwares
 * supplies for itself. Read runtime_core.c's own comment at the include site
 * for why the seam is here.
 *
 * What a consumer must define, and nothing else:
 *
 *   const app_t *const g_apps[];   the app table (app.h)
 *   const int g_appCount;
 *   const int g_menuAppIndex[];    the menu's roster, indices into g_apps[]
 *   const int g_menuAppCount;
 *   extern const app_t g_menuApp;  the picker itself, addressed by
 *                                  APP_INDEX_MENU rather than by an index
 *   extern void menu_set_return_app(int index);
 *
 * The externs for the app objects themselves belong here too, for the reason
 * runtime_core.c's own comment used to give: an extern per app is the whole
 * dependency, and including each app's header instead would drag apps/ into
 * the runtime's include set for nothing.
 *
 * THIS IS THE PACK'S REFERENCE ROSTER: three apps and a menu. A pack ships a
 * reference firmware (docs/convention/device-pack.md), not a product, so this
 * is deliberately the smallest roster that still exercises the menu, the
 * switch and the arena. A consumer with its own apps writes its own copy of
 * this file and takes every other runtime source unchanged.
 */

extern const app_t g_chronoApp;
extern const app_t g_sketchApp;
extern const app_t g_timerApp;
extern const app_t g_menuApp;
extern void menu_set_return_app(int index);

// Appended, never inserted: index 0 is what boots (app.h) and the regression
// tests under wasm/tests/ address apps by their index in this array, so a new
// app goes on the end.
const app_t *const g_apps[] = { &g_chronoApp, &g_sketchApp, &g_timerApp };
const int g_appCount = sizeof(g_apps) / sizeof(g_apps[0]);

// The menu's own roster: which g_apps[] entries the picker draws, and in what
// order. Identical to g_apps[] here because a three-app reference firmware has
// no reason to hide anything - but it is still a SEPARATE table, because
// app.h's contract is that taking an app off the menu is a roster decision and
// never a deletion, and a consumer that uses that (the pocket-computer
// firmware this pack was extracted from shows six of its eleven) must find the
// mechanism already here rather than have to reintroduce it.
const int g_menuAppIndex[] = {
    0, // chrono
    1, // sketch ("draw")
    2, // timer
};
const int g_menuAppCount = (int)(sizeof(g_menuAppIndex) / sizeof(g_menuAppIndex[0]));
