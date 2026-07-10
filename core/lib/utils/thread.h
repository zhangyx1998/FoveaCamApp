// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

// Portable thread naming. The pthread signatures diverge by platform:
//   - macOS: pthread_setname_np(const char *) names the CALLING thread.
//   - Linux (glibc): pthread_setname_np(pthread_t, const char *) and the name
//     is truncated to 15 bytes + NUL (longer names return ERANGE — harmless,
//     the return value is ignored since this is only a debugging aid).
// Callers always name the current thread, so wrap both forms behind one call.

#include <pthread.h>

inline void set_thread_name(const char *name) {
#if defined(__APPLE__)
  pthread_setname_np(name);
#else
  pthread_setname_np(pthread_self(), name);
#endif
}
