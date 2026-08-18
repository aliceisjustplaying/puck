# The portable runtime (../runtime) and the reference app (../apps) are
# pulled straight into this one component rather than split into their own
# idf_component - they compile identically for wasm (wasm/build.ts) and the
# board, and splitting them into a second ESP-IDF component would buy
# nothing this pack needs today. If this pack ever grows a second app, an
# app table replaces this SRCS entry the same way it would replace
# runtime_core.c's single g_app pointer - see runtime_core.c's header
# comment.
idf_component_register(
    SRCS
        "main.c"
        "display.c"
        "touch.c"
        "button.c"
        "imu.c"
        "../runtime/runtime_core.c"
        "../runtime/gfx_band.c"
        "../apps/demo.c"
    INCLUDE_DIRS
        "."
        "../runtime"
        "../apps"
)
