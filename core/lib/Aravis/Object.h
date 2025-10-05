// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <glib-object.h>

#include <utils/pointer.h>

/**
 * @brief Thin wrapper around g-object based Aravis objects.
 *
 * This template provides RAII semantics for GObject-based Aravis objects,
 * automatically managing reference counting to prevent memory leaks.
 *
 * @tparam P The underlying GObject pointer type (e.g., ArvCamera*)
 * @tparam O The derived wrapper class type for CRTP
 */
template <typename P, typename O> class Object {
private:
  friend O;
  P *const ptr;

public:
  /**
   * @brief Construct from raw pointer, taking ownership with reference
   * increment
   * @param ptr Raw pointer to GObject (must not be null)
   */
  Object(P *ptr) : ptr(noNull(ptr)) { g_object_ref(ptr); }

  /**
   * @brief Copy constructor - increments reference count
   * @param other Object to copy from
   */
  Object(const Object &other) : ptr(other.ptr) { g_object_ref(ptr); }

  /**
   * @brief Move constructor - transfers ownership without ref count change
   * @param other Object to move from (will be left in valid but empty state)
   */
  Object(Object &&other) noexcept : ptr(other.ptr) {
    // Transfer ownership without changing reference count
    const_cast<P *&>(other.ptr) = nullptr;
  }

  /**
   * @brief Copy assignment operator
   * @param other Object to assign from
   * @return Reference to this object
   */
  Object &operator=(const Object &other) {
    if (this != &other) {
      // Increment new reference first (in case of self-assignment through
      // aliasing)
      g_object_ref(other.ptr);
      // Decrement old reference
      g_object_unref(ptr);
      // Update pointer
      const_cast<P *&>(ptr) = other.ptr;
    }
    return *this;
  }

  /**
   * @brief Move assignment operator
   * @param other Object to move from
   * @return Reference to this object
   */
  Object &operator=(Object &&other) noexcept {
    if (this != &other) {
      // Release current object
      g_object_unref(ptr);
      // Transfer ownership
      const_cast<P *&>(ptr) = other.ptr;
      const_cast<P *&>(other.ptr) = nullptr;
    }
    return *this;
  }

  /**
   * @brief Destructor - decrements reference count
   */
  ~Object() {
    if (ptr != nullptr) {
      g_object_unref(ptr);
    }
  }

  /**
   * @brief Get the raw pointer
   * @return Raw pointer to the underlying GObject
   */
  P *get() const { return ptr; }

  /**
   * @brief Get the value of raw pointer in size_t
   * @return Value of raw pointer in size_t
   */
  size_t id() const { return reinterpret_cast<size_t>(ptr); }

  /**
   * @brief Dereference operator for convenience
   * @return Reference to the underlying GObject
   */
  P &operator*() const { return *ptr; }

  /**
   * @brief Arrow operator for member access
   * @return Raw pointer for member access
   */
  P *operator->() const { return ptr; }

  /**
   * @brief Boolean conversion operator
   * @return true if pointer is not null, false otherwise
   */
  explicit operator bool() const noexcept { return ptr != nullptr; }

  /**
   * @brief Equality comparison
   * @param other Object to compare with
   * @return true if both objects wrap the same pointer
   */
  bool operator==(const Object &other) const noexcept {
    return ptr == other.ptr;
  }

  /**
   * @brief Inequality comparison
   * @param other Object to compare with
   * @return true if objects wrap different pointers
   */
  bool operator!=(const Object &other) const noexcept {
    return ptr != other.ptr;
  }
};
