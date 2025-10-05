// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <iostream>
#include <mutex>
#include <string>

#include "map-set.h"
#include <utils/type-name.h>

namespace RefCount {

template <typename K, typename V> class Map;
template <typename V> class Reference;

// Base class that handles reference counting without knowing about K
template <typename V> class RootReferenceBase {
protected:
  V value;
  std::mutex mtx;
  size_t count = 0;

public:
  template <typename K> RootReferenceBase(const K &key) : value(key) {}

  virtual ~RootReferenceBase() {
    if (count != 0) {
      std::cerr << "[FATAL] RootReference of " + type_name<V>() +
                       " destroyed with non-zero count (" +
                       std::to_string(count) + ")";
      std::terminate();
    }
  }

  void incRef() {
    std::scoped_lock<std::mutex> lock(mtx);
    count++;
  }

  // Pure virtual - derived class handles cleanup
  virtual void decRef() = 0;

  Reference<V> reference() { return Reference<V>(this); }

  V &getValue() { return value; }
  const V &getValue() const { return value; }
};

template <typename K, typename V>
class RootReference : public RootReferenceBase<V> {
private:
  friend class Reference<V>;
  Map<K, V> &map;
  const K key;

  void decRef() override {
    std::scoped_lock<std::mutex, std::mutex> lock(this->mtx, map.mtx);
    this->count--;
    if (this->count == 0)
      map.erase(key);
  }

public:
  RootReference(Map<K, V> &m, const K &k)
      : RootReferenceBase<V>(k), map(m), key(k) {}
};

template <typename V> class Reference {
private:
  RootReferenceBase<V> *root; // Use base class pointer

public:
  Reference(RootReferenceBase<V> *r) : root(r) {
    if (root)
      root->incRef();
  }
  Reference(const Reference &other) : root(other.root) {
    if (root)
      root->incRef();
  }
  Reference(Reference &&other) noexcept : root(other.root) {
    other.root = nullptr;
  }
  ~Reference() {
    if (root)
      root->decRef();
  }
  RootReferenceBase<V> &ref() const {
    if (root == nullptr)
      throw std::runtime_error("Dereferencing a moved-from reference of " +
                               type_name<V>());
    return *root;
  }
  V *get() const { return &ref().getValue(); }
  V &operator*() const { return ref().getValue(); }
  V *operator->() const { return &ref().getValue(); }
};

template <typename K, typename V>
class Map : private ::Map<K, std::unique_ptr<RootReference<K, V>>> {
  friend class RootReference<K, V>;
  std::mutex mtx;

public:
  Reference<V> get(const K &key) {
    std::lock_guard<std::mutex> lock(mtx);
    if (!this->has(key))
      this->insert({key, std::make_unique<RootReference<K, V>>(*this, key)});
    return this->at(key)->reference();
  }
};

} // namespace RefCount
