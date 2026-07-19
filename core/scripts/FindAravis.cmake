# Find the ARAVIS library
# --------------------------
# ARAVIS_FOUND        - True if ARAVIS was found.
# ARAVIS_LIBRARIES    - The libraries needed to use ARAVIS
# ARAVIS_INCLUDE_DIRS - Location of ARAVIS.h

unset(ARAVIS_FOUND)
unset(ARAVIS_INCLUDE_DIRS)
unset(ARAVIS_LIBRARIES)

find_package(PkgConfig REQUIRED)
# Try to find aravis-0.8 using pkg-config. The module name is lowercase to
# match the installed `aravis-0.8.pc`; macOS/Homebrew's case-insensitive
# filesystem tolerates `ARAVIS-0.8`, but Linux pkg-config is case-sensitive.
pkg_check_modules(ARAVIS REQUIRED aravis-0.8)

if(NOT ARAVIS_FOUND)
    message(FATAL_ERROR "ARAVIS-0.8 not found. Please install ARAVIS development packages.")
endif()
