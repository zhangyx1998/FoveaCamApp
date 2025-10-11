// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#include <arv.h>
#include <string>

#include <Aravis/Error.h>
#include <convert.h>

using namespace Arv;

template <> ArvAcquisitionMode convert(const std::string &src) {
  if (src == "Continuous")
    return ARV_ACQUISITION_MODE_CONTINUOUS;
  if (src == "SingleFrame")
    return ARV_ACQUISITION_MODE_SINGLE_FRAME;
  if (src == "MultiFrame")
    return ARV_ACQUISITION_MODE_MULTI_FRAME;
  throw Error("Invalid ArvAcquisitionMode string: " + src);
}

template <> std::string convert(const ArvAcquisitionMode &src) {
  switch (src) {
  case ARV_ACQUISITION_MODE_CONTINUOUS:
    return "Continuous";
  case ARV_ACQUISITION_MODE_SINGLE_FRAME:
    return "SingleFrame";
  case ARV_ACQUISITION_MODE_MULTI_FRAME:
    return "MultiFrame";
  default:
    throw Error("Invalid ArvAcquisitionMode value: " + std::to_string(src));
  }
}

template <> ArvAuto convert(const std::string &src) {
  if (src == "Off")
    return ARV_AUTO_OFF;
  if (src == "Once")
    return ARV_AUTO_ONCE;
  if (src == "Continuous")
    return ARV_AUTO_CONTINUOUS;
  throw Error("Invalid ArvAuto string: " + src);
}

template <> std::string convert(const ArvAuto &src) {
  switch (src) {
  case ARV_AUTO_OFF:
    return "Off";
  case ARV_AUTO_ONCE:
    return "Once";
  case ARV_AUTO_CONTINUOUS:
    return "Continuous";
  default:
    throw Error("Invalid ArvAuto value: " + std::to_string(src));
  }
}
