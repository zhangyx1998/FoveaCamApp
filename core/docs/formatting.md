# Code Formatting

## Copyright Headers

All source and header files needs to start with the copyright header.
Author and contact information is subject to change according to contribution.

```c++
// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
```

## Include ordering and grouping

Include statements should directly follow the copyright header with no blank line.
For headers, `#pragma once` should be at the top and separated into its own group.

Headers should be split into five groups (omitted if none existent):

1. C/C++ standard libraries, e.g. `<string>`, `<cstring>`, etc
2. Externally managed libraries (i.e. installed by OS package manager), e.g. `<opencv2/opencv.hpp>`
3. Headers under `lib/`, included using angled brackets.
3. For `xxx.cpp` that implements `xxx.h`, `#include "xxx.h"` forms a separate group.
4. All other project local includes, using double-quote style include.

Each group should be separated by exactly one blank line, the internal order of
each group should follow the auto-ordering of clangd-format.

## Blank lines

There should be no more than one blank line separating any code block.
Namespaces should always start and end with a blank line.
All source and header files must end with a new line.
