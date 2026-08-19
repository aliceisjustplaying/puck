# The portable runtime (../runtime) and the app (../apps, or wherever
# PUCK_APP_SOURCE points) are pulled straight into this one component
# rather than split into their own idf_component - they compile identically
# for wasm (wasm/build.ts) and the board, and splitting them into a second
# ESP-IDF component would buy nothing this pack needs today.
#
# PUCK_APP_SOURCE is this build's equivalent of wasm/build.ts's --app flag,
# and exists for the same reason: this pack has one app SLOT, not one app.
# A port living outside the pack (apps/chrono/ports/esp32-s3-touch-amoled-18/
# chrono.c) fills that slot by defining the same `g_demoApp` symbol
# runtime_core.c declares. Keeping the two builds' app selection the same
# shape is what lets the emulator side and the board side of a differential
# run be the same app rather than two apps that look alike.
#
#   idf.py build
#   idf.py -DPUCK_APP_SOURCE=<absolute path to a .c> build
#
# CMake caches this, so switching apps needs the flag on the command line
# that changes it, not on every later build; `idf.py fullclean` resets it.
if(NOT PUCK_APP_SOURCE)
    set(PUCK_APP_SOURCE "${CMAKE_CURRENT_LIST_DIR}/../apps/demo.c")
endif()
get_filename_component(PUCK_APP_SOURCE "${PUCK_APP_SOURCE}" ABSOLUTE)
get_filename_component(PUCK_APP_DIR "${PUCK_APP_SOURCE}" DIRECTORY)
message(STATUS "puck app slot: ${PUCK_APP_SOURCE}")

idf_component_register(
    SRCS
        "main.c"
        "display.c"
        "touch.c"
        "button.c"
        "imu.c"
        "../devlink.c"
        "../runtime/runtime_core.c"
        "../runtime/gfx_band.c"
        "${PUCK_APP_SOURCE}"
    INCLUDE_DIRS
        "."
        ".."
        "../runtime"
        "../apps"
        "${PUCK_APP_DIR}"
)
