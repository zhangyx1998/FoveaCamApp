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
set(CMAKE_BUILD_TYPE Debug)

set(SRC_DIR ${PROJECT_HOME}/src)
set(INC_DIR ${PROJECT_HOME}/include)
# Get all the cpp files in the src directory
file(GLOB SRCS ${SRC_DIR}/*.cpp ${SRC_DIR}/**/*.cpp)

# set(CMAKE_CXX_FLAGS "-Wall -Wno-ignored-qualifiers")
set(CMAKE_CXX_FLAGS_DEBUG "-g -DDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3")
add_definitions(${CXX_FLAGS})

# Dependencies
find_package(NodeApiHeaders REQUIRED)
find_package(NodeAddonApi REQUIRED)
find_package(LibUSB REQUIRED)
find_package(Aravis REQUIRED)
find_package(LZ4 REQUIRED)
find_package(OpenCV REQUIRED COMPONENTS
  core        # cv::Mat and basic structures
  imgproc     # cv::cvtColor and image processing
  aruco       # ArUco marker detection (future)
  tracking    # KCF tracker (future)
)
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
  Addon.cpp
  ${SRCS}
  ${LIB_SRCS}
  ${SHARED_LIB_SRCS}
)

add_library(fovea_shm_reader SHARED
  reader/ShmReaderAddon.cpp
)


set_target_properties(core PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  # macOS: embed run paths so Electron can resolve ARAVIS/GenICam deps
  MACOSX_RPATH ON
  BUILD_RPATH "@loader_path;/usr/local/lib"
  INSTALL_RPATH "@loader_path;/usr/local/lib"
  INSTALL_NAME_DIR "@rpath"
)

set_target_properties(fovea_shm_reader PROPERTIES
  PREFIX ""
  SUFFIX ".node"
  MACOSX_RPATH ON
  BUILD_RPATH "@loader_path;/usr/local/lib"
  INSTALL_RPATH "@loader_path;/usr/local/lib"
  INSTALL_NAME_DIR "@rpath"
)

# Link with libraries
target_link_libraries(core PRIVATE
  ${CMAKE_JS_LIB}
  ${OpenCV_LIBS}
  ${ARAVIS_LIBRARIES}
  ${LibUSB_LIBRARIES}
  ${LZ4_LIBRARIES}
)

target_link_libraries(fovea_shm_reader PRIVATE
  ${CMAKE_JS_LIB}
)
