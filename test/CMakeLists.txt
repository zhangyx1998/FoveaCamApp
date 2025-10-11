# =============================================================================
# Build Recipe For Node.js core Addon Module
# =============================================================================
# License: MIT
# Author: Yuxuan Zhang (zhangyuxuan@ufl.edu)
# =============================================================================
cmake_minimum_required(VERSION 3.10)
project(tests)
set(PROJECT_HOME ${CMAKE_CURRENT_SOURCE_DIR})

# CMake Parameters and Variables
set(CMAKE_CXX_STANDARD 20)
set(CMAKE_CXX_STANDARD_REQUIRED ON)
set(CMAKE_EXPORT_COMPILE_COMMANDS ON)
set(CMAKE_BUILD_TYPE Debug)

set(SRC_DIR ${PROJECT_HOME})
# Get all the cpp files in the src directory
file(GLOB SRCS ${SRC_DIR}/*.cpp ${SRC_DIR}/**/*.cpp)

# set(CMAKE_CXX_FLAGS "-Wall -Wno-ignored-qualifiers")
set(CMAKE_CXX_FLAGS_DEBUG "-g -DDEBUG")
set(CMAKE_CXX_FLAGS_RELEASE "-O3")

# header files and libraries
include_directories(
  ${PROJECT_HOME}/../lib/ # Shared lib
)

# Project Local Library
file(GLOB SHARED_LIB_SRCS ${PROJECT_HOME}/../lib/**/*.cpp)

# Build Targets
foreach(SRC ${SRCS})
  get_filename_component(TEST_NAME ${SRC} NAME_WE)
  add_executable(${TEST_NAME} ${SRC} ${SHARED_LIB_SRCS})
endforeach()
