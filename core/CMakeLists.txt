# =============================================================================
# Build Recipe For Node.js core Addon Module
# =============================================================================
# License: MIT
# Author: Yuxuan Zhang (zhangyuxuan@ufl.edu)
# =============================================================================
cmake_minimum_required(VERSION 3.10)
project(core)
set(PROJECT_HOME ${CMAKE_CURRENT_SOURCE_DIR})
list(APPEND CMAKE_MODULE_PATH ${PROJECT_HOME}/scripts)

# CMake Parameters and Variables
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
# Optimized-with-symbols, ALWAYS. This line was `Debug` (-g only, NO -O) from
# 2025-10-11 until 2026-07-10 — every native brick ran at -O0; the recorder's
# vector copies executed BYTE-BY-BYTE (~82 fps writer vs ~1500 fps at -O2, the
# frame-drop root cause). `-g` stays: the crash handler's backtraces need
# symbols. `-DDEBUG` stays: it only gates the env-controlled VERBOSE logging.
set(CMAKE_BUILD_TYPE Debug)

set(SRC_DIR ${PROJECT_HOME}/src)
set(INC_DIR ${PROJECT_HOME}/include)
# Get all the cpp files in the src directory
file(GLOB SRCS ${SRC_DIR}/*.cpp ${SRC_DIR}/**/*.cpp)

# set(CMAKE_CXX_FLAGS "-Wall -Wno-ignored-qualifiers")
set(CMAKE_CXX_FLAGS_DEBUG "-O2 -g -DDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3")
add_definitions(${CXX_FLAGS})
# When a Napi::Error can't be rethrown into JS (env terminating, or an
# exception already pending), node-addon-api otherwise throws AGAIN inside a
# noexcept frame -> libc++ "terminating due to uncaught exception of type
# Napi::Error" -> SIGABRT (took the whole orchestrator down on the rig,
# 2026-07-08). This define turns exactly those unthrowable states into no-ops.
add_definitions(-DNODE_API_SWALLOW_UNTHROWABLE_EXCEPTIONS)

# Dependencies
find_package(NodeApiHeaders REQUIRED)
find_package(NodeAddonApi REQUIRED)
find_package(LibUSB REQUIRED)
find_package(Aravis REQUIRED)
find_package(LZ4 REQUIRED)
# multi-fovea-recording ruling 9: the compression brick uses system zlib (libz)
# for per-frame intra-frame compression — no new dependency (CMake ships
# FindZLIB; libz is present on every target platform).
find_package(ZLIB REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS
  core        # cv::Mat and basic structures
  imgproc     # cv::cvtColor and image processing
  aruco       # ArUco marker detection (future)
  tracking    # KCF tracker (future)
  OPTIONAL_COMPONENTS
  ximgproc    # WLS disparity refine (stereo-throughput.md) — a contrib module;
              # a build without it still compiles, `wls` degrades to a no-op
)
if(";${OpenCV_LIBS};" MATCHES ";opencv_ximgproc;")
  add_definitions(-DHAVE_OPENCV_XIMGPROC_WLS)
  message(STATUS "OpenCV ximgproc found — stereo WLS refine enabled")
else()
  message(STATUS "OpenCV ximgproc NOT found — stereo WLS refine disabled")
endif()
# header files and libraries
include_directories(
  ${INC_DIR}      # project local include directory
  ${PROJECT_HOME}/lib/
  ${PROJECT_HOME}/assets/
  ${PROJECT_HOME}/../lib/ # Shared lib
  ${CMAKE_JS_INC}
  ${NodeApiHeaders_INCLUDE_DIRS}
  ${NodeAddonApi_INCLUDE_DIRS}
  ${OpenCV_INCLUDE_DIRS}
  ${ARAVIS_INCLUDE_DIRS}
  ${LibUSB_INCLUDE_DIRS}
  ${LZ4_INCLUDE_DIRS}
  ${ZLIB_INCLUDE_DIRS}
)

# Library linkables
link_directories(
  ${OpenCV_LIBRARY_DIRS}
  ${ARAVIS_LIBRARY_DIRS}
  ${LibUSB_LIBRARY_DIRS}
  ${LZ4_LIBRARY_DIRS}
)

# Project Local Library
file(GLOB LIB_SRCS ${PROJECT_HOME}/lib/**/*.cpp)
file(GLOB SHARED_LIB_SRCS ${PROJECT_HOME}/../lib/**/*.cpp)

# Build Targets
add_library(core SHARED
  addon.cpp
  ${SRCS}
  ${LIB_SRCS}
  ${SHARED_LIB_SRCS}
)

add_library(fovea_shm_reader SHARED
  reader/ShmReaderAddon.cpp
  ${SRC_DIR}/ShmRead.cpp   # shared libc-only read TU (also compiled into core)
)


set_target_properties(core PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

set_target_properties(fovea_shm_reader PROPERTIES
  PREFIX ""
  SUFFIX ".node"
)

# Embed run paths so Electron can resolve ARAVIS/GenICam deps. The rpath tokens
# are platform-specific: macOS uses @loader_path, ELF (Linux) uses $ORIGIN.
if(APPLE)
  set_target_properties(core fovea_shm_reader PROPERTIES
    MACOSX_RPATH ON
    BUILD_RPATH "@loader_path;/usr/local/lib"
    INSTALL_RPATH "@loader_path;/usr/local/lib"
    INSTALL_NAME_DIR "@rpath"
  )
elseif(UNIX)
  set_target_properties(core fovea_shm_reader PROPERTIES
    BUILD_RPATH "$ORIGIN;/usr/local/lib"
    INSTALL_RPATH "$ORIGIN;/usr/local/lib"
  )
endif()

# Link with libraries
target_link_libraries(core PRIVATE
  ${CMAKE_JS_LIB}
  ${OpenCV_LIBS}
  ${ARAVIS_LIBRARIES}
  ${LibUSB_LIBRARIES}
  ${LZ4_LIBRARIES}
  ${ZLIB_LIBRARIES}
)

target_link_libraries(fovea_shm_reader PRIVATE
  ${CMAKE_JS_LIB}
)
