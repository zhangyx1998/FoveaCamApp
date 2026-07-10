// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// Native crash-site tracing for the orchestrator (teardown-hardening, Task 3).
//
// The 2026-07-09 incident aborted with only a libc++ one-liner ("terminating
// due to uncaught exception ... mutex lock failed: Invalid argument") and NO
// native stack — macOS wrote no .ips for the utilityProcess. installCrashHandler
// closes that gap: a std::set_terminate hook + SIGABRT/SIGSEGV/SIGBUS handlers
// print a banner, the exception message (terminate only), the module load base
// (for offline `atos` symbolication of the offset-only .node frames) and the
// native backtrace to stderr, then RE-RAISE so the process still dies with the
// same signal / exit code. That exit-code preservation is load-bearing: exit 6
// is what triggers the janitor that parks MEMS/cameras (hardware-quiescence
// invariant) — the handler must observe-and-die, never swallow.
//
// Async-signal-pragmatic: the signal path uses only write(2) + backtrace /
// backtrace_symbols_fd (all async-signal-safe on Darwin) and a manual hex
// writer — no malloc, no printf, no std::string. The terminate path is NOT a
// signal context, so it may rethrow the current exception to recover what().

#include <atomic>
#include <csignal>
#include <cstddef>
#include <cstdint>
#include <cstdlib>
#include <cstring>
#include <exception>

#include <dlfcn.h>
#include <execinfo.h>
#include <unistd.h>

#include <napi.h>

namespace {

// Captured at install time so the signal handler can print it without touching
// the loader (async-signal-safe reads of plain globals).
char g_module_path[1024] = {0};
uintptr_t g_module_base = 0; // mach-o load address (slide) of this .node image

// Re-entrancy / double-dump guard: terminate() -> abort() re-enters through the
// SIGABRT handler; print the rich dump once, then let the re-raise fall through.
volatile sig_atomic_t g_dumped = 0;

constexpr int kStderr = 2;

inline void write_str(const char *s) {
  if (s)
    (void)!::write(kStderr, s, std::strlen(s));
}

// Async-signal-safe "0x…" hex writer (no printf).
inline void write_hex(uintptr_t v) {
  char buf[2 + sizeof(uintptr_t) * 2];
  char *p = buf;
  *p++ = '0';
  *p++ = 'x';
  bool started = false;
  for (int shift = static_cast<int>(sizeof(uintptr_t)) * 8 - 4; shift >= 0;
       shift -= 4) {
    const unsigned nyb = static_cast<unsigned>((v >> shift) & 0xF);
    if (nyb != 0 || started || shift == 0) {
      *p++ = static_cast<char>(nyb < 10 ? '0' + nyb : 'a' + (nyb - 10));
      started = true;
    }
  }
  (void)!::write(kStderr, buf, static_cast<size_t>(p - buf));
}

void print_module_info() {
  write_str("  module: ");
  write_str(g_module_path[0] ? g_module_path : "<core.node>");
  write_str("  base=");
  write_hex(g_module_base);
  write_str("\n  symbolicate offset-only frames with: atos -o <core.node> -l ");
  write_hex(g_module_base);
  write_str(" <addr>\n");
}

void print_backtrace() {
  void *frames[128];
  const int n = ::backtrace(frames, 128);
  // backtrace_symbols_fd is async-signal-safe (writes directly, no malloc).
  ::backtrace_symbols_fd(frames, n, kStderr);
}

const char *signal_name(int sig) {
  switch (sig) {
  case SIGABRT:
    return "SIGABRT";
  case SIGSEGV:
    return "SIGSEGV";
  case SIGBUS:
    return "SIGBUS";
  default:
    return "signal";
  }
}

extern "C" void crash_signal_handler(int sig) {
  if (!g_dumped) {
    g_dumped = 1;
    write_str("\n=== FoveaCam native crash handler === ");
    write_str(signal_name(sig));
    write_str("\n");
    print_module_info();
    print_backtrace();
    write_str("=== end native backtrace (re-raising for default handling) "
              "===\n");
  }
  // SA_RESETHAND reset our disposition to SIG_DFL before entry, so re-raising
  // takes the DEFAULT path: the process dies with this signal, exit-code /
  // signal semantics unchanged (exit 6 -> janitor parks hardware). We never
  // swallow — an Electron child's crashpad, if it chained here, still sees the
  // faulting thread die.
  ::raise(sig);
}

void crash_terminate_handler() {
  if (!g_dumped) {
    g_dumped = 1;
    write_str("\n=== FoveaCam native crash handler === std::terminate\n");
    // Not a signal context: recover the in-flight exception's message.
    if (std::exception_ptr ex = std::current_exception()) {
      try {
        std::rethrow_exception(ex);
      } catch (const std::exception &e) {
        write_str("  uncaught exception: ");
        write_str(e.what());
        write_str("\n");
      } catch (...) {
        write_str("  uncaught exception: <non-std::exception type>\n");
      }
    } else {
      write_str("  terminate called with no active exception\n");
    }
    print_module_info();
    print_backtrace();
    write_str("=== end native backtrace (aborting; exit code preserved) ===\n");
  }
  // Preserve abort() semantics (SIGABRT -> exit 6 -> janitor). This re-enters
  // crash_signal_handler for SIGABRT, but g_dumped short-circuits the reprint.
  std::abort();
}

} // namespace

// installCrashHandler(): idempotent. Wire std::set_terminate + SIGABRT/SIGSEGV/
// SIGBUS so any native crash prints a symbolicatable backtrace before the
// process dies with unchanged exit-code semantics. Call ONCE at core-loading
// boot (orchestrator entry). Root addon export; not part of the public d.ts.
Napi::Value installCrashHandler(const Napi::CallbackInfo &info) {
  auto env = info.Env();
  static std::atomic<bool> installed{false};
  bool expected = false;
  if (installed.compare_exchange_strong(expected, true)) {
    // Capture this module's load base for offline symbolication.
    Dl_info dli;
    if (::dladdr(reinterpret_cast<void *>(&installCrashHandler), &dli)) {
      if (dli.dli_fname) {
        std::strncpy(g_module_path, dli.dli_fname, sizeof(g_module_path) - 1);
        g_module_path[sizeof(g_module_path) - 1] = '\0';
      }
      g_module_base = reinterpret_cast<uintptr_t>(dli.dli_fbase);
    }
    std::set_terminate(crash_terminate_handler);
    struct sigaction sa;
    std::memset(&sa, 0, sizeof(sa));
    sa.sa_handler = crash_signal_handler;
    sigemptyset(&sa.sa_mask);
    // SA_RESETHAND: run our handler once, then restore SIG_DFL so the re-raise
    // dies by default action (never a loop). Chains cleanly with crashpad.
    sa.sa_flags = SA_RESETHAND;
    ::sigaction(SIGABRT, &sa, nullptr);
    ::sigaction(SIGSEGV, &sa, nullptr);
    ::sigaction(SIGBUS, &sa, nullptr);
  }
  return env.Undefined();
}
