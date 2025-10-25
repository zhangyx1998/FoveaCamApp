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

class Cleanup {
public:
  typedef void *Data;
  typedef void (*Callback)(Data);
  typedef struct Hook {
    void *const self;
    Callback const callback;
  } Hook;

private:
  class Registry {
    typedef struct Entry {
      Data const data;
      Callback const callback;
      const std::string info;
    } Entry;
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
        try {
          const auto &entry = hooks.back();
          VERBOSE("Calling Hook %s @ %p", entry.info.c_str(), entry.data);
          entry.callback(entry.data);
          hooks.pop_back();
        } catch (const std::exception &e) {
          std::cerr << "[ERROR] Exception in Cleanup hook: " << e.what()
                    << std::endl;
        }
      }
    }
    inline void add(Data data, Callback callback, std::string info) {
      VERBOSE("Registering Hook %s @ %p", info.c_str(), data);
      hooks.push_back({data, callback, info});
    }
    inline void remove(Data data) {
      hooks.remove_if(
          [data](const Entry &entry) { return entry.data == data; });
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
  template <typename T>
  static inline void add(Napi::Env env, T data, void (*callback)(T),
                         std::string info = "<unknown>") {
    auto ref = registry.ref();
    auto &reg = get(env, ref);
    reg.add((Data)data, (Callback)callback, info);
  }
  static inline void remove(Napi::Env env, Data data) {
    auto ref = registry.ref();
    auto &reg = get(env, ref);
    reg.remove(data);
  }
  static inline void clear(Napi::Env env) { registry.ref()->erase(env); }
};
