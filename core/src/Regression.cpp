// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

#include <cstdlib>
#include <string>
#include <vector>

#include "napi.h"
#include <opencv2/core.hpp>

#include "napi-helper.h"
#include "utils/map-set.h"

using std::string;
using std::vector;

/**
 * @brief Solve the linear regression problem using the normal equation.
 *
 * Minimize ||X * K - Y||
 *
 * @param X Input feature matrix [N_Samples * N_Features]
 * @param Y Output target vector [N_Samples]
 * @param K Output coefficient vector [N_Features]
 */
void solve(const vector<vector<double>> &X, const vector<double> &Y,
           vector<double> &K) {
  const size_t m = X.size();    // Number of samples
  const size_t n = X[0].size(); // Number of features
  // Convert input data to OpenCV matrices
  cv::Mat X_mat(m, n, CV_64F);
  cv::Mat Y_mat(m, 1, CV_64F);
  // Fill X matrix
  for (size_t i = 0; i < m; i++) {
    for (size_t j = 0; j < n; j++) {
      X_mat.at<double>(i, j) = X[i][j];
    }
  }
  // Fill Y vector
  for (size_t i = 0; i < m; i++) {
    Y_mat.at<double>(i, 0) = Y[i];
  }
  // Resize output vector and wrap it in a cv::Mat to reuse memory
  K.resize(n);
  cv::Mat K_mat(n, 1, CV_64F, K.data());
  // Solve using normal equation: K = (X^T * X)^(-1) * X^T * Y
  // Using OpenCV's solve function which is more numerically stable
  cv::solve(X_mat, Y_mat, K_mat, cv::DECOMP_SVD);
}

typedef struct RegressionConfig {
  vector<int> ply;
  vector<double> sin, cos, tan, cot, log, exp; // Reserved, unused;
} RegressionConfig;

template <> RegressionConfig convert(const Napi::Value &value) {
  if (!value.IsObject())
    throw JS::TypeError(value.Env(), "Argument must be an object");
  auto obj = value.As<Napi::Object>();
  return {
      .ply = optionalArgument<vector<int>>(obj.Get("pow"), {}),
      .log = optionalArgument<vector<double>>(obj.Get("log"), {}),
      .exp = optionalArgument<vector<double>>(obj.Get("exp"), {}),
  };
}

template <typename T>
concept DoubleOrString =
    std::same_as<T, double> || std::same_as<T, std::string>;

template <DoubleOrString T> inline constexpr T initialValue() {
  if constexpr (std::is_same_v<T, std::string>)
    return "";
  else
    return 1.0;
}

template <DoubleOrString T>
inline void expandPlyRecursive(size_t i, bool neg, unsigned remainder,
                               vector<unsigned> &ply, const vector<T> &data,
                               vector<T> &out) {
  const auto size = std::min(data.size(), ply.size());
  if (i >= size || remainder == 0) {
    T ret = initialValue<T>();
    for (unsigned j = 0; j < i; j++) {
      const auto &p = ply[j];
      if (p == 0)
        continue;
      const auto &v = data[j];
      if constexpr (std::is_same_v<T, std::string>) {
        if (p == 0)
          continue;
        bool first = ret.empty();
        if (!first)
          ret += " * ";
        ret += v;
        if (neg || p > 1) {
          ret += "^";
          if (neg)
            ret += "-";
          ret += std::to_string(p);
        }
      } else {
        ret *= ::pow(v, neg ? -(signed)(p) : (signed)(p));
      }
    }
    out.push_back(ret);
  } else {
    auto &p = ply[i];
    if (i == size - 1) {
      p = remainder;
      expandPlyRecursive(i + 1, neg, 0, ply, data, out);
    } else {
      for (p = remainder;; p--) {
        expandPlyRecursive(i + 1, neg, remainder - p, ply, data, out);
        if (p == 0)
          break;
      }
    }
  }
}

template <DoubleOrString T>
void expandPly(int ply, const vector<T> &data, vector<T> &out) {
  if (ply == 0) {
    if constexpr (std::is_same_v<T, std::string>)
      return out.push_back("");
    else
      return out.push_back(1.0);
  }
  bool neg = ply < 0;
  std::vector<unsigned> p(data.size(), 0);
  expandPlyRecursive<T>(0, neg, std::abs(ply), p, data, out);
}

class RegressionObject : public Napi::ObjectWrap<RegressionObject> {
public:
  static Napi::Function Init(Napi::Env env) {
    return DefineClass(env, "Regression",
                       {
                           INSTANCE_GETTER(RegressionObject, features),
                           INSTANCE_GETTER(RegressionObject, targets),
                           INSTANCE_GETTER(RegressionObject, expansions),
                           INSTANCE_GETTER(RegressionObject, parameters),
                           INSTANCE_METHOD(RegressionObject, toString),
                           INSTANCE_METHOD(RegressionObject, expand),
                           INSTANCE_METHOD(RegressionObject, fit),
                           INSTANCE_METHOD(RegressionObject, predict),
                       });
  }
  const Napi::Env env;
  RegressionObject(const Napi::CallbackInfo &info)
      : Napi::ObjectWrap<RegressionObject>(info), env(info.Env()) {
    try {
      features = convert<vector<string>>(info[0]);
      targets = convert<vector<string>>(info[1]);
      config = optionalArgument<RegressionConfig>(info[2],
                                                  {.ply = {3, 2, 1, 0}});
      // Expansions are used to determine number of weights
      for (const auto &p : config.ply)
        expandPly(p, features, expansions);
      // Initialize weights
      const auto count = expansions.size();
      for (const auto &t : targets)
        weights[t] = vector<double>(count, 0.0);
    }
    JS_EXCEPT();
  };

private:
  vector<string> features, targets, expansions;
  Map<string, vector<double>> weights;
  RegressionConfig config;

  GET(features) {
    try {
      return convert(env, features);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(targets) {
    try {
      return convert(env, targets);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(expansions) {
    try {
      return convert(env, expansions);
    }
    JS_EXCEPT(env.Undefined())
  }

  GET(parameters) {
    try {
      auto obj = Napi::Object::New(env);
      for (const auto &t : targets)
        obj.Set(t, convert(env, weights[t]));
      return obj;
    }
    JS_EXCEPT(env.Undefined())
  }

  FN(toString) noexcept {
    std::stringstream ss;
    for (const auto &t : targets) {
      const auto &w = weights[t];
      ss << t << " = ";
      for (size_t i = 0; i < w.size(); i++) {
        if (i != 0 && w[i] >= 0)
          ss << " + ";
        ss << w[i];
        const auto &exp = expansions[i];
        if (!exp.empty())
          ss << " * " << exp;
      }
      ss << "\n";
    }
    return convert(env, ss.str());
  }

  inline vector<double> extract(const Napi::Object &obj, vector<string> &keys) {
    vector<double> out;
    out.reserve(keys.size());
    for (const auto &key : keys) {
      try {
        out.push_back(convert<double>(obj.Get(key)));
      } catch (...) {
        throw JS::TypeError(env, repr(obj, 1) + " missing numeric property '" +
                                     key + "'");
      }
    }
    return out;
  }

  inline vector<double> extract(const Napi::Array &arr, const string &key) {
    vector<double> out;
    out.reserve(arr.Length());
    for (size_t i = 0; i < arr.Length(); i++) {
      auto el = arr.Get(i);
      if (!el.IsObject())
        throw JS::TypeError(env, "Array element " + std::to_string(i) + " " +
                                     repr(el) + " is not an object");
      try {
        out.push_back(convert<double>(el.As<Napi::Object>().Get(key)));
      } catch (...) {
        throw JS::TypeError(env, repr(el, 1) + " missing numeric property '" +
                                     key + "'");
      }
    }
    return out;
  }

  inline vector<double> expand(const Napi::Object &obj) {
    auto i = extract(obj, features);
    vector<double> o;
    o.reserve(expansions.size());
    for (const auto &p : config.ply)
      expandPly(p, i, o);
    return o;
  }

  FN(fit) {
    try {
      auto inputs = info[0].As<Napi::Array>();
      auto outputs = info[1].As<Napi::Array>();
      vector<vector<double>> X;
      X.reserve(inputs.Length());
      for (size_t i = 0; i < inputs.Length(); i++)
        X.push_back(expand(inputs.Get(i).As<Napi::Object>()));
      // Perform fitting per target
      for (const auto &t : targets) {
        auto &K = weights[t];
        auto Y = extract(outputs, t);
        solve(X, Y, K);
      }
      return info.This();
    }
    JS_EXCEPT(info.This())
  }

  FN(expand) {
    try {
      return convert(env, expand(info[0].As<Napi::Object>()));
    }
    JS_EXCEPT(env.Undefined())
  };

  FN(predict) {
    try {
      auto v = expand(info[0].As<Napi::Object>());
      auto r = Napi::Object::New(env);
      for (const auto &t : targets) {
        const auto &w = weights[t];
        double ret = 0.0;
        for (size_t i = 0; i < w.size(); i++)
          ret += w[i] * v[i];
        r.Set(t, convert(env, ret));
      }
      return r;
    }
    JS_EXCEPT(env.Undefined())
  }
};

void exportRegressionObject(Napi::Env env, Napi::Object &exports) {
  VERBOSE_TIMER("export RegressionObject");
  exports.Set("Regression", RegressionObject::Init(env));
}
