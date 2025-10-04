// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
#pragma once

#include <unordered_map>
#include <unordered_set>

template <typename V> class Set : public std::unordered_set<V> {
public:
  using std::unordered_set<V>::unordered_set;
  bool has(const V &value) const { return this->find(value) != this->end(); }
  Set<V> inline clone() const { return *this; }
};

template <typename K, typename V> class Map : public std::unordered_map<K, V> {
public:
  using std::unordered_map<K, V>::unordered_map;
  bool has(const K &key) const { return this->find(key) != this->end(); }
  V &get(const K &key) {
    return this->at(key); // will throw std::out_of_range if key not found
  }
  V &set(const K &key, V &value) {
    this->insert({key, value});
    return value;
  }
  V &set(const K &key, V &&value) {
    this->insert({key, std::move(value)});
    return value;
  }
  Map<K, V> inline clone() const { return *this; }
};
