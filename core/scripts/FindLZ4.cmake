# Find the LZ4 library
# --------------------------
# LZ4_FOUND        - True if LZ4 was found.
# LZ4_LIBRARIES    - The libraries needed to use LZ4
# LZ4_INCLUDE_DIRS - Location of lz4.h
# LZ4_LIBRARY_DIRS - Location of library files

unset(LZ4_FOUND)
unset(LZ4_INCLUDE_DIRS)
unset(LZ4_LIBRARIES)
unset(LZ4_LIBRARY_DIRS)

find_package(PkgConfig REQUIRED)
pkg_check_modules(liblz4 REQUIRED liblz4)

if (NOT liblz4_FOUND)
    message(FATAL_ERROR "liblz4 not found. Please install lz4 development packages.")
else()
    set(LZ4_FOUND TRUE)
    set(LZ4_INCLUDE_DIRS ${liblz4_INCLUDE_DIRS})
    set(LZ4_LIBRARY_DIRS ${liblz4_LIBRARY_DIRS})
    set(LZ4_LIBRARIES ${liblz4_LINK_LIBRARIES})
    message(STATUS "Found lz4: ${LZ4_LIBRARIES}")
    message(STATUS "  Include dirs: ${LZ4_INCLUDE_DIRS}")
    message(STATUS "  Library dirs: ${LZ4_LIBRARY_DIRS}")
endif()
