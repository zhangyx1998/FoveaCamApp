// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <concepts>
#include <cstdint>
#include <memory>

#include <utils/type-name.h>

// Detect common aliases, when present
template <class P>
concept HasPointerAlias = requires { typename P::pointer; };

template <class P>
concept HasElementType = requires { typename P::element_type; };

template <typename T> inline T *noNull(T *ptr) {
  if (ptr == nullptr)
    throw std::runtime_error("Null pointer to " + type_name<T>());
  return ptr;
}

// Matches any "smart pointer" that provides .get() returning a pointer-like
// value. We accept three common shapes:
//
// 1) unique_ptr-style:     .get() convertible to P::pointer
// 2) shared_ptr-style:     .get() convertible to element_type*
// 3) generic fallback:     .get() convertible to (const void*)
//
template <class P>
concept SmartPtrLike =
    // must have a .get() member
    requires(P p) { p.get(); } &&
    (
        // unique_ptr with possibly fancy pointer type
        (HasPointerAlias<P> &&
         requires(P p) {
           { p.get() } -> std::convertible_to<typename P::pointer>;
         }) ||
        // shared_ptr (no pointer alias, but has element_type)
        (HasElementType<P> &&
         requires(P p) {
           { p.get() } -> std::convertible_to<typename P::element_type *>;
         }) ||
        // generic fallback: plain raw object pointer
        requires(P p) {
          { p.get() } -> std::convertible_to<const void *>;
        });

template <typename T> inline uintptr_t uintptr(T *ptr) {
  return reinterpret_cast<uintptr_t>(ptr);
}

template <SmartPtrLike T> inline uintptr_t uintptr(T &ptr) {
  return reinterpret_cast<uintptr_t>(ptr.get());
}

template <typename Derived> class Shared {
public:
  using Ptr = std::shared_ptr<Derived>;
  template <typename... Args> static inline Ptr create(Args &&...args) {
    return std::make_shared<Derived>(std::forward<Args>(args)...);
  }
};

template <typename Derived> class Unique {
public:
  using Ptr = std::unique_ptr<Derived>;
  template <typename... Args> static inline Ptr create(Args &&...args) {
    return std::make_unique<Derived>(std::forward<Args>(args)...);
  }
};
