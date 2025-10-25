// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <iostream>
#include <mutex>
#include <string>

#include "debug.h"
#include "map-set.h"
#include <type_name.h>

namespace RefCount {

template <typename K, typename V, auto Index, typename I> class RootReference;
template <typename V> class Reference;

template <typename K, typename I = K> I index(const K &key) { return key; }

template <typename K, typename V, auto Index = index<K>,
          typename I = decltype(Index(std::declval<K>()))>
class Map : private ::Map<I, std::unique_ptr<RootReference<K, V, Index, I>>> {
private:
  friend class RootReference<K, V, Index, I>;
  std::mutex mtx;

public:
  Reference<V> get(const K &key) {
    std::lock_guard<std::mutex> lock(mtx);
    const I index = Index(key);
    if (!this->has(index))
      this->insert(
          {index, std::make_unique<RootReference<K, V, Index, I>>(*this, key)});
    return this->at(index)->reference();
  }
};

// Base class that handles reference counting without knowing about K
template <typename V> class RootReferenceBase {
protected:
  V value;
  std::mutex mtx;
  size_t count = 0;

public:
  template <typename K> RootReferenceBase(const K &key) : value(key) {
    VERBOSE("Created root reference for %s @ %p", type_name<V>().c_str(), this);
  }

  virtual ~RootReferenceBase() {
    if (count != 0)
      std::cerr << "[ref-count] [WARN] RootReference of " + type_name<V>() +
                       " destroyed with non-zero reference (" +
                       std::to_string(count) + ")"
                << std::endl;
    VERBOSE("Destroyed root reference for %s @ %p", type_name<V>().c_str(),
            this);
  }

  void incRef() {
    std::scoped_lock<std::mutex> lock(mtx);
    VERBOSE("Incremented reference count for %s @ %p: %zu -> %zu",
            type_name<V>().c_str(), this, count, count + 1);
    count++;
  }

  // Pure virtual - derived class handles cleanup
  virtual void decRef() = 0;

  Reference<V> reference() { return Reference<V>(this); }

  V &getValue() { return value; }
  const V &getValue() const { return value; }
};

template <typename K, typename V, auto Index, typename I>
class RootReference : public RootReferenceBase<V> {
private:
  friend class Reference<V>;
  Map<K, V, Index, I> &map;
  const K key;

  void decRef() override {
    std::scoped_lock<std::mutex, std::mutex> lock(this->mtx, map.mtx);
    VERBOSE("Decremented reference count for %s @ %p: %zu -> %zu",
            type_name<V>().c_str(), this, this->count, this->count - 1);
    this->count--;
    if (this->count == 0)
      map.erase(Index(key));
  }

public:
  RootReference(Map<K, V, Index, I> &m, const K &k)
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

} // namespace RefCount
