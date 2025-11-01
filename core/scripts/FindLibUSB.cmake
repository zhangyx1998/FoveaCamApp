# Find the LibUSB library
# --------------------------
# LibUSB_FOUND        - True if LibUSB was found.
# LibUSB_LIBRARIES    - The libraries needed to use LibUSB
# LibUSB_INCLUDE_DIRS - Location of libusb.h
# LibUSB_LIBRARY_DIRS - Location of library files

unset(LibUSB_FOUND)
unset(LibUSB_INCLUDE_DIRS)
unset(LibUSB_LIBRARIES)
unset(LibUSB_LIBRARY_DIRS)

find_package(PkgConfig REQUIRED)
pkg_check_modules(libusb-1.0 REQUIRED libusb-1.0)

if (NOT libusb-1.0_FOUND)
    message(FATAL_ERROR "libusb-1.0 not found. Please install libusb-1.0 development packages.")
else()
    set(LibUSB_FOUND TRUE)
    set(LibUSB_INCLUDE_DIRS ${libusb-1.0_INCLUDE_DIRS})
    set(LibUSB_LIBRARY_DIRS ${libusb-1.0_LIBRARY_DIRS})
    set(LibUSB_LIBRARIES ${libusb-1.0_LINK_LIBRARIES})
    message(STATUS "Found libusb-1.0: ${LibUSB_LIBRARIES}")
    message(STATUS "  Include dirs: ${LibUSB_INCLUDE_DIRS}")
    message(STATUS "  Library dirs: ${LibUSB_LIBRARY_DIRS}")
endif()
