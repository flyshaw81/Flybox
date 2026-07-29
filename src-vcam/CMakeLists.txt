cmake_minimum_required(VERSION 3.16)
project(flybox-virtualcam LANGUAGES C CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
# Match OBS virtualcam: static CRT for the filter DLL
set(CMAKE_MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>")

# --- minimal dshow output stack from libdshowcapture ---
set(DSHOW_SRC
  vendor/libdshowcapture/source/output-filter.cpp
  vendor/libdshowcapture/source/dshow-base.cpp
  vendor/libdshowcapture/source/dshow-enum.cpp
  vendor/libdshowcapture/source/dshow-formats.cpp
  vendor/libdshowcapture/source/dshow-media-type.cpp
  vendor/libdshowcapture/source/log.cpp
)

add_library(flybox-dshow STATIC ${DSHOW_SRC})
target_include_directories(flybox-dshow PUBLIC
  vendor/libdshowcapture
  vendor/libdshowcapture/source
)
target_compile_definitions(flybox-dshow PUBLIC
  _UP_WINDOWS=1
  UNICODE
  _UNICODE
)
target_compile_options(flybox-dshow PRIVATE /wd4005 /wd4018 /W3)
target_link_libraries(flybox-dshow PUBLIC strmiids ole32 oleaut32 uuid setupapi)

# --- shared memory + nv12 ---
add_library(flybox-queue STATIC
  vendor/queue/shared-memory-queue.c
  vendor/nv12/tiny-nv12-scale.c
)
target_include_directories(flybox-queue PUBLIC
  vendor/queue
  vendor/nv12
)

# --- virtual camera filter DLL ---
add_library(flybox-virtualcam-module MODULE
  flybox-filter/virtualcam-module.cpp
  flybox-filter/virtualcam-filter.cpp
  flybox-filter/placeholder.cpp
  flybox-filter/sleepto.c
  flybox-filter/flybox-virtualcam64.def
)
target_include_directories(flybox-virtualcam-module PRIVATE
  flybox-filter
  vendor/queue
  vendor/nv12
  vendor/util
  vendor/util/windows
  vendor/libdshowcapture
  vendor/libdshowcapture/source
)
target_compile_definitions(flybox-virtualcam-module PRIVATE
  VIRTUALCAM_AVAILABLE
  _UP_WINDOWS=1
  UNICODE
  _UNICODE
)
target_link_libraries(flybox-virtualcam-module PRIVATE
  flybox-dshow
  flybox-queue
  gdiplus
  strmiids
  winmm
  ole32
  oleaut32
  uuid
)
set_target_properties(flybox-virtualcam-module PROPERTIES
  OUTPUT_NAME "flybox-virtualcam-module64"
  MSVC_RUNTIME_LIBRARY "MultiThreaded$<$<CONFIG:Debug>:Debug>"
  PREFIX ""
)

# install scripts next to DLL
configure_file(
  ${CMAKE_CURRENT_SOURCE_DIR}/scripts/flybox-vcam-install.bat
  ${CMAKE_BINARY_DIR}/flybox-vcam-install.bat
  COPYONLY
)
configure_file(
  ${CMAKE_CURRENT_SOURCE_DIR}/scripts/flybox-vcam-uninstall.bat
  ${CMAKE_BINARY_DIR}/flybox-vcam-uninstall.bat
  COPYONLY
)
