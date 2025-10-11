// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <glib-object.h>

#include <pointer.h>

/**
 * @brief Thin wrapper around g-object based Aravis objects.
 *
 * This template provides RAII semantics for GObject-based Aravis objects.
 *
 * @tparam P The underlying GObject pointer type (e.g., ArvCamera*)
 * @tparam O The derived wrapper class type for CRTP
 */
template <typename P, typename O> class Object {
private:
  P *ptr;

public:
  /**
   * @brief Construct from raw pointer, taking ownership with reference
   * increment
   * @param ptr Raw pointer to GObject (must not be null)
   */
  Object(P *&&ptr) : ptr(ptr) {}

  /**
   * @brief Copy constructor - increments reference count
   * @param other Object to copy from
   */
  Object(const Object &other) = delete;

  /**
   * @brief Move constructor - transfers ownership without ref count change
   * @param other Object to move from (will be left in valid but empty state)
   */
  Object(Object &&other) = delete;

  /**
   * @brief Destructor - decrements reference count
   */
  ~Object() { g_clear_object(&ptr); }

  /**
   * @brief Get the raw pointer
   * @return Raw pointer to the underlying GObject
   */
  inline P *const &get() const { return ptr; }

  /**
   * @brief Dereference operator for convenience
   * @return Reference to the underlying GObject
   */
  inline P &operator*() const { return *ptr; }

  /**
   * @brief Arrow operator for member access
   * @return Raw pointer for member access
   */
  inline P *operator->() const { return ptr; }

  /**
   * @brief Boolean conversion operator
   * @return true if pointer is not null, false otherwise
   */
  inline explicit operator bool() const noexcept { return ptr != nullptr; }

  /**
   * @brief Equality comparison
   * @param other Object to compare with
   * @return true if both objects wrap the same pointer
   */
  inline bool operator==(const Object &other) const noexcept {
    return ptr == other.ptr;
  }

  /**
   * @brief Equality comparison
   * @param other Object to compare with
   * @return true if both objects wrap the same pointer
   */
  inline bool operator==(const P *other) const noexcept { return ptr == other; }

  /**
   * @brief Inequality comparison
   * @param other Object to compare with
   * @return true if objects wrap different pointers
   */
  bool operator!=(const Object &other) const noexcept {
    return ptr != other.ptr;
  }
};
