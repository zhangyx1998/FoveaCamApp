# AGENTS.md

This file provides guidance to coding agents when working with code in this repository.

## Project Overview

FoveaCam Duo — a stereo camera desktop application for capture, calibration, and vision processing. Combines a C++ native addon (Node-API), an Electron + Vue 3 UI, and Teensy 4.0 firmware, organized as an npm workspace monorepo.

## Build Commands

### Setup
```bash
npm install          # installs all workspaces and builds core (via postinstall)
```

### Core (C++ native addon)
```bash
cd core
make build           # configure + build for Node.js and Electron, then generate compiledb
make configure       # reconfigure cmake only
make clean           # remove build artifacts and .cache
```

### App (Electron + Vue 3)
```bash
npm run app          # launch Electron dev server with HMR (from repo root)
cd app && npm run dev        # same, from app directory
cd app && npm run build      # production build (type-check + vite + electron-builder)
```

### Firmware (Teensy 4.0, PlatformIO)
```bash
cd firmware
make build           # pio build
make upload          # flash to device
make monitor         # serial monitor
make clean           # clean (required after changing shared lib/ files)
```

### C++ Tests
```bash
cd test && make build && ./build/cobs
```

### App Tests (vitest session harness)
```bash
cd app && npm test      # plain-TS suites over Channel/Session/Hub + control math
```

### Formatting
- TS/JS/Vue/JSON: `prettier --write`
- C++/H: `clang-format -i`
- Both enforced via lint-staged pre-commit hooks

### Compile Database
```bash
npm run compiledb    # regenerate root compile_commands.json for clangd
```

## Workflow

After making a code change, always state two things before moving on:
- **Effect scope** — which process(es)/module(s)/files the change actually
  touches, and just as importantly what it does *not* touch (e.g. "orchestrator
  session + its one renderer client; no other module imports this contract").
  This matters because the renderer and orchestrator are separate processes —
  a change can compile clean on both sides of that boundary while still being
  wrong about what crosses it (wire shape, camera exclusivity, lifecycle
  timing), so "which side(s) does this run on" is part of the scope, not an
  aside.
- **What to verify in the GUI** — concretely, which module to open, which
  interaction to perform, and what should (and should not) be observed. Type
  checking and the vue-tsc gate catch shape errors, not behavior — they will
  not catch a camera that never opens, a stream that silently stops, or a
  control loop that's live but wrong. Name the specific screen/button/slider,
  not just "test the feature."

## Architecture

### Monorepo Layout
- **`core/`** — C++ Node-API addon wrapping OpenCV, Aravis (GigE Vision cameras), libusb, and serial I/O. Built with cmake-js for both Node.js and Electron runtimes. Exports submodules: Aravis, Controller, Vision, Tracker, Regression, Geometry, Log, Shm, Pipe, Topology, Recorder. C++ helpers live in `core/include/` (CoreObject, AsyncTask, Dispatcher, etc.) and `core/lib/` (Aravis, Stream, Threading, utils); native sources in `core/src/`.
- **`app/`** — Electron main/preload/renderer with Vue 3 + Vite. Feature modules live in `app/modules/` (calibrate-intrinsic, calibrate-extrinsic, calibrate-distortion, calibrate-drift, disparity-scope, single-capture, multi-fovea, manage-cameras, manage-data, manual-control, playground). Shared UI components in `app/src/components/`, utility libraries in `app/lib/`. Electron main/preload/util in `app/electron/`. The **orchestrator** (a separate Electron `utilityProcess`) owns `core`/hardware and runs in `app/orchestrator/`; its renderer-shared contracts/transport are in `app/lib/orchestrator/`. See the Orchestrator subsection below.
- **`firmware/`** — Arduino/C++ for Teensy 4.0 microcontroller (MEMS sensors, serial protocol); sources in `firmware/src/`.
- **`lib/`** — Shared C++ libraries used by both `core` and `firmware` (Protocol, COBS, Buffer, Timer). Changes here require `make clean` in `firmware/` because PlatformIO copies rather than references these files.
- **`test/`** — Standalone C++ test executables (CMake-based).
- **`playground/`** — Standalone TS scratch scripts and benchmarks (not part of the app build).

### Orchestrator (renderer ↔ utility process)

`core` ownership — camera acquisition, vision, control loops, hardware I/O,
config — lives in a dedicated Electron `utilityProcess` (its own libuv loop);
the renderer is a thin I/O surface bound to the Vue/Chromium render loop.
Architecture docs: [`docs/architecture/`](./docs/architecture/README.md)
(processes, sessions, stream graph, windows, metering, recorder, serial
protocol). The refactor that produced this architecture is archived under
[`docs/history/refactor/`](./docs/history/refactor/README.md).

- **`app/orchestrator/`** — the utility-process entry (`index.ts`, a
  registration list) + `Hub`/`ServerSession`/`defineSession` runtime, the
  camera `registry.ts` (refcounted `CameraLease`s, one shared `Camera`/stream
  per serial, `onFrame` payload + in-process `onView` Mat taps), the serial
  `controller.ts`, `calibration.ts` loader, the config store proxy
  `store-hub.ts` (a thin client to main's config authority — see App Patterns
  below; `store.ts` holds only the fs primitives), and `diagnostics.ts`
  (process-wide error reporting). Only `system` and
  `controller` sessions live here (`sessions/`) — they're cross-cutting
  singletons with no owning UI module. Every other session is co-located with
  its feature: `modules/<m>/session.ts` next to that module's `contract.ts`
  and `index.vue`. Reach orchestrator infra from a co-located session via the
  `@orchestrator/*` alias, not relative paths.
- **`app/lib/orchestrator/`** — transport shared by both processes: `protocol.ts`
  (typed `Contract`/`defineContract`, the RPC `Channel` with request/response,
  events for state+telemetry, frames with a per-topic in-flight backpressure
  gate, plus a process-wide `error` event), `contracts.ts` (cross-cutting
  contracts; feature contracts live in `modules/<m>/contract.ts`), and the
  renderer `client.ts` (`useSession` → `{ state, telemetry }` as Vue `reactive()`
  objects — read/write as plain properties, e.g. `state.verge`, no `.value` —
  plus `frame(name)` refs and `call(name, arg)`). Keep orchestrator-reachable
  code (anything a `session.ts` imports, including shared `@lib`) **Vue-free** —
  `vue` is a devDependency, so importing it there bundles all of Vue into the
  utility process.
- Every feature module runs through an orchestrator session; the renderer is
  `core`-free (type-only imports allowed). Cameras are exclusive per OS
  process — registry leases inside the orchestrator are the only camera
  access. Items awaiting hardware verification are tracked in
  `docs/hardware/stage-f.md`; the HIL procedure is
  `docs/dev/verification-playbook.md`. The developer gate suite is
  `docs/dev/gates.md`.

### Core Addon Infrastructure

#### Function Definition & Export
```cpp
#define FN(NAME) Napi::Value NAME(const Napi::CallbackInfo &info)  // core/include/napi-helper.h
// Each module source defines its own EXPORT helper, e.g.:
#define EXPORT(OBJ, F) OBJ.Set(#F, Function::New<F>(env, #F));
// Usage: static FN(save) { ... }  →  EXPORT(exports, save);
```
`FN`, `GET`, `SET` live in `core/include/napi-helper.h`. Getter/setter macros: `GET(name)` → `get_name()`, `SET(name)` → `set_name()`.

#### Type Conversion (`convert<T>`)
Bidirectional template system in `lib/convert.h` and `core/include/napi-helper.h`:
```cpp
template <> T convert(const Napi::Value &value);              // JS → C++
template <> Napi::Value convert(Napi::Env env, const T &v);   // C++ → JS
template <> Napi::Value convert(Napi::Env env, const Napi::Value &container, const T &v); // C++ → JS (reuse buffer)
```
Supports all primitives, `cv::Mat`, `cv::Point_<T>`, `cv::Size_<T>`, `cv::Rect_<T>`, `std::vector<T>`, enums, and `CameraCalibration`. Mat conversion creates TypedArray with `shape` and `channels` properties. Container overload copies into existing buffer when sizes match (zero-alloc frame updates).

#### Optional Arguments
```cpp
template <typename T> T optionalArgument(const Napi::Value &arg, T &&fallback);
// Returns fallback if arg is undefined/null, otherwise convert<T>(arg)
```

#### CoreObject<Obj, Core>
Base class for wrapping native C++ objects as JS objects (`core/include/CoreObject.h`). Inherits `Napi::ObjectWrap<Obj>`, manages lifecycle via per-env context storage with cleanup hooks.
- `core()` — access underlying native object (throws if released)
- `Create(env, ...)` — construct JS wrapper from native ptr or args
- `ref()` / `release()` — reference counting
- JS `release()` is an explicit early dereference to avoid waiting for GC. After
  `release()`, the same JS wrapper is invalid: any property or method access
  except another idempotent `release()` must be treated as a bug and will throw.
  Capture needed JS values before release, or call `ref()` before transferring
  ownership to code that may release independently.
- Registration: `CORE_OBJECT_DECL(Self)` in class body, `CORE_OBJECT_REGISTER(Cls, env)` in Init, `CORE_OBJECT(Cls)` after class definition to generate `export##Cls` + convert specializations. In `Addon.cpp`, `CORE_OBJECT_EXPORT(Cls, env, target)` attaches the object/namespace to a submodule object.

#### AsyncTask<T>
Runs `std::function<T()>` on a std::thread, resolves a JS Promise with `convert(env, result)`. Two overloads: `run(env, task)` and `run(container, task)` (reuses buffer).

#### Exception Handling
```cpp
JS_THROW(ErrorType, message, returnValue)   // Throw JS error with native stack
JS_EXCEPT(returnValue)                       // catch block: std::exception → JS Error
JS_ASSERT(cond, ErrorType, message, ret)     // Assert with JS throw
```
Standard pattern: `try { ... } JS_EXCEPT(env.Undefined())`

#### Shared/Unique Base Classes
`Shared<Derived>` provides `using Ptr = shared_ptr<Derived>` and `static Ptr create(Args...)`.

#### Exporting an Object or Namespace
Addon.cpp registers a root `core` object with submodules: `core.Aravis`, `core.Controller`, `core.Vision`, `core.Tracker`, `core.Regression`, `core.Geometry`, `core.Log`, `core.Shm`, `core.Pipe`, `core.Topology`, `core.Recorder` (plus a top-level `cleanup`). All but `Recorder` also have a `core/<Module>` subpath in `core/package.json`'s `exports` map (`Recorder` is root-object-only today). On js side, core/dist/index.mjs re-exports named exports from each submodule index.mjs, which in turn re-exports from the root loader. This allows both `import { Vision } from "core"` and `import Vision from "core/Vision"` patterns. When adding a new submodule or namespace, update `Addon.cpp`, the root loader (`core/dist/index.{cjs,mjs}`), and `core/package.json`'s `exports` map accordingly.

#### Build & Distribution
- Multi-target: `core/scripts/make.cjs` builds `.node` for both Node.js and Electron → `core/dist/.bin/{runtime}-{version}-{arch}.node`
- `core/dist/index.cjs` loads the correct `.node` binary by detecting runtime/version/arch, injects `__origin__` on each submodule
- `core/dist/index.mjs` wraps the CJS loader with `createRequire` (handles Electron's `/@fs/` URL scheme in dev)
- `core/scripts/code-gen.cjs` auto-generates per-submodule CJS/ESM glue: each `core/dist/{Module}/index.{cjs,mjs}` re-exports from the root loader
- `core/package.json` `exports` map provides `"core/Vision"`, `"core/Aravis"`, etc. with separate `import`/`require`/`types` entries
- Type declarations in `core/dist/{Module}/index.d.ts` are hand-written using `declare module "core/{Module}"` — **not** auto-generated. When adding new C++ functions, the `.d.ts` must be manually updated to expose them to TypeScript
- `core/dist/types.d.ts` defines shared types: `TypedArray`, `BufferLike`, `Awaitable<T>`, `CoreObject<T>`, `Stream<T>`

### App Patterns
- **New features are orchestrator sessions** — `modules/<m>/{contract.ts,
  session.ts, index.vue}`: hardware/`core`/vision in `session.ts`
  (Vue-free), thin Vue client over `useSession()` in `index.vue`. Do NOT
  import `core` in renderer code — the old direct-NAPI-in-renderer pattern
  is retired (one legacy exception: the scratch `modules/playground/index.vue`;
  `src/graphics/Marker.vue` is no longer an exception — it uses only the
  generated `@lib/marker-patterns.generated`, no `core`).
- Persistent config authority is **MAIN** (`app/electron/store-main.ts`). Both
  the renderer `app/lib/store.ts` (over `ipcRenderer`) and the orchestrator's
  `store-hub.ts` (over its `parentPort`) are thin clients with the same
  `Store.open/clear/list/read` API; the old per-instance orchestrator store-hub
  authority is retired. Local edits send key-level patches and changes broadcast
  to ALL windows/instances. A store-migration framework (`store/schema.json`
  version, git-snapshotted) runs at startup. No electron-store, no renderer file
  access.
- Vite path aliases (mirrored in `app/tsconfig.json`): `@` and `@src` = `app/src/`, `@lib` = `app/lib/`, `@modules` = `app/modules/`, `@orchestrator` = `app/orchestrator/`

## Key Dependencies
- **OpenCV** (core, imgproc, aruco, tracking) — vision processing
- **Aravis** — GigE Vision camera acquisition
- **libusb** — USB device I/O
- **zlib** — recording compression (CompressStream brick + MCAP writer). The old LZ4-backed `core.Compression` module was dead code and is removed (2026-07-11)
- **C++20** standard for all native code
- **Node-API 8** — stable ABI for native addon
</content>
</invoke>
