// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <iostream>
#include <list>

#include <napi.h>

#include <Threading/Guard.h>
#include <utils/debug.h>
#include <utils/map-set.h>
#include <utils/stacktrace.h>

class Cleanup {
public:
  typedef std::function<void()> Hook;
  typedef size_t UID;

private:
  typedef struct Entry {
    UID uid;
    const std::string info;
    Hook callback;
  } Entry;
  class Registry {
    UID counter = 1; // 0 is reserved for cleared hooks.
    std::list<Entry> hooks;
    const Napi::Env env;

  public:
    Registry() = delete;
    Registry(const Registry &) = delete;
    Registry &operator=(const Registry &) = delete;
    Registry(Registry &&) = delete;
    Registry &operator=(Registry &&) = delete;
    inline Registry(Napi::Env env) : env(env) {}
    inline ~Registry() {
      VERBOSE("Calling %zu hooks for Env %p", hooks.size(),
              static_cast<napi_env>(env));
      while (!hooks.empty()) {
        const auto &entry = hooks.back();
        try {
          VERBOSE("Calling Hook %s @ %p", entry.info.c_str(), &entry.callback);
          entry.callback();
        } catch (const std::exception &e) {
          std::cerr << "[ERROR] [Cleanup] During cleanup of " << entry.info
                    << ": " << e.what() << std::endl;
          VERBOSE("Stack trace:\n%s", Stacktrace::capture().c_str());
        }
        hooks.pop_back();
      }
    }
    inline UID add(Hook hook, std::string info) {
      VERBOSE("Registering Hook %s @ %p", info.c_str(), &hook);
      const auto uid = counter++;
      hooks.push_back({uid, info, hook});
      return uid;
    }
    inline void remove(UID uid) {
      if (uid == 0)
        return;
      // Search from back
      for (auto it = hooks.rbegin(); it != hooks.rend(); ++it) {
        if (it->uid == uid) {
          VERBOSE("Removing Hook %s @ %p", it->info.c_str(), &it->callback);
          hooks.erase(std::next(it).base());
          return;
        }
        if (it->uid < uid) {
          break; // Not found
        }
      }
    }
  };

private:
  static inline Threading::Guard<Map<napi_env, Registry>> registry;

  static inline Registry &
  get(Napi::Env env, Threading::Guard<Map<napi_env, Registry>>::Ref &ref) {
    if (!ref->has(env)) {
      ref->emplace(env, env);
      auto &reg = ref->get(env);
      env.AddCleanupHook(clear, static_cast<napi_env>(env));
      return reg;
    } else {
      return ref->get(env);
    }
  }

public:
  static inline UID add(Napi::Env env, Hook hook,
                        std::string info = "<unknown>") {
    auto ref = registry.ref();
    auto &reg = get(env, ref);
    return reg.add(hook, info);
  }
  static inline void remove(Napi::Env env, UID &uid) {
    auto ref = registry.ref();
    if (ref->has(env))
      ref->get(env).remove(uid);
    uid = 0;
  }
  static inline void clear(Napi::Env env) { registry.ref()->erase(env); }
};
