// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

export type Sequence<T = any> = Iterable<T> & {
    length: number;
    [index: number]: T;
};

export type Awaitable<T> = T | Promise<T>;
