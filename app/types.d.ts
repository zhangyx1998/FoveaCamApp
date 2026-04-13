// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------

type Sequence<T = any> = Iterable<T> & {
  length: number;
  [index: number]: T;
};

type Awaitable<T> = T | Promise<T>;

type Mutable<T> = { -readonly [P in keyof T]: T[P] };

type BufferLike = Buffer | ArrayBuffer | ArrayBufferView;

type Empty = null | undefined;

declare module "*.py?raw" {
  const src: string;
  export default src;
}
