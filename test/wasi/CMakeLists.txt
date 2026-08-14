cmake_minimum_required(VERSION 3.24)
project(puck_wasi_fixture LANGUAGES CXX)

if(NOT CMAKE_CXX_COMPILER_TARGET STREQUAL "wasm32-wasip1")
  message(FATAL_ERROR "the WASI fixture requires CMAKE_CXX_COMPILER_TARGET=wasm32-wasip1")
endif()

add_executable(cxx_reactor firmware/cxx_reactor.cpp)
target_compile_features(cxx_reactor PRIVATE cxx_std_20)
target_compile_options(cxx_reactor PRIVATE
  -ffunction-sections
  -fdata-sections
  -fno-exceptions
  -fno-rtti
)
target_link_options(cxx_reactor PRIVATE
  -mexec-model=reactor
  -Wl,--export-memory
  -Wl,--gc-sections
  -Wl,--initial-memory=1048576
  -Wl,--max-memory=4194304
  -Wl,-z,stack-size=262144
  -Wl,--export=emu_device
  -Wl,--export=emu_init
  -Wl,--export=emu_tick
  -Wl,--export=emu_fb
  -Wl,--export=emu_push_count
  -Wl,--export=emu_push_x
  -Wl,--export=emu_push_y
  -Wl,--export=emu_push_w
  -Wl,--export=emu_push_h
  -Wl,--export=emu_touch
  -Wl,--export=emu_button
  -Wl,--export=emu_button_verdict
  -Wl,--export=emu_sensor_event
)
set_target_properties(cxx_reactor PROPERTIES
  OUTPUT_NAME cxx_reactor
  SUFFIX .wasm
  RUNTIME_OUTPUT_DIRECTORY "${CMAKE_CURRENT_LIST_DIR}/dist"
)
