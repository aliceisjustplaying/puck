/* app_tunables.inc: which of this firmware's apps expose live tunables.
 *
 * INCLUDED, not compiled, by firmware/runtime/tune_registry.c, which is a pack
 * source (docs/convention/device-pack.md) and aggregates these providers
 * without knowing which apps exist. Read that file's comment at the include
 * site for why the seam is here; the short version is that a provider row
 * naming an app a firmware does not compile is a link error, not a stale
 * comment.
 *
 * One row per app that declares live tunables, in the order `TUNE` (bare list)
 * and the emulator's tunables panel present them. The function names come from
 * sensors.h's "DEVELOPMENT: live tuning" section. An empty array is legal.
 *
 * THE PACK'S REFERENCE FIRMWARE has one: the sketchpad's dropout-tolerance
 * thresholds, behind SKETCH_LIVE_TUNE. sensors.h also DECLARES clock_tune_*
 * and tables_tune_*, for apps that live in the pocket-computer firmware this
 * pack was extracted from and not here - declarations with no definition, and
 * harmless precisely because this array is what would force a link.
 */
static const tune_provider_t g_tuneProviders[] = {
    { sketch_tune_count, sketch_tune_describe, sketch_tune_define_name, sketch_tune_get, sketch_tune_set },
};
