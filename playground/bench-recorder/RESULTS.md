# Recorder container format bench — results (B-4)

**Spec:** `docs/refactor/recorder-container.md` §2. **Machine:** MacBook, Apple
M1 Max, 10 cores / 32 GB RAM, internal SSD (`dd` anchor: ~1.48 GB/s sustained
sequential write of zero-filled data — an optimistic upper bound, not a
guarantee for entropic payloads). Single dev laptop, not an isolated bench
rig — other processes (Electron dev servers, browser, etc.) may have been
running; treat absolute numbers as directional, not lab-grade.

Run: `cd playground/bench-recorder && /opt/homebrew/bin/node src/bench.ts --size=<1.5|6.2> --compression=<none|lz4|zstd> --duration=32 --out=./out`

## Methodology / honesty notes

- **Architecture under test:** one `worker_threads` worker hosts a single
  `McapWriter` multiplexing **all 4 channels into one file** (3 raw camera
  streams @ 60 fps + 1 processed stream @ 30 fps) — this is the new
  single-file container the format eval is deciding between, not today's
  per-stream `.stream`/`.meta` writer. `McapWriter` is documented
  non-reentrant ("wait on any method call to complete before calling
  another"), so every `addMessage()` across all 4 channels is serialized
  through one promise chain in the worker — same pattern as
  `stream-writer.ts`'s `chain = chain.then(...)`, just multiplexed.
- **Synthetic frames, not real sensor data.** Real 12-bit raw frames have
  scene structure + a photon/read noise floor; all-zero or all-random test
  data would give a meaningless compression ratio in either direction. Bench
  frames are synthesized as a few low-frequency sinusoids (scene proxy) +
  ~12-LSB Gaussian-ish noise, quantized to 12 bits and packed with the same
  bit layout Aravis/GenICam use for `*12p` formats (2 px → 3 bytes) — see
  `src/synth.ts`. **Real Bayer compressibility may differ** (better or
  worse) from these numbers; treat the none/lz4/zstd *relative* comparison
  and the throughput-ceiling finding as the reliable takeaways, not the
  exact compression ratios.
- **Frame sizes:** target ~1.5 MiB → 1024×1024 12p (1,572,864 B exact);
  target ~6.2 MiB → 2082×2082 12p (6,502,086 B, ~6.20 MiB). Processed stream
  is a separate synthetic 8-bit map sized at ~1/8 of the raw target.
- **CPU accounting:** `process.cpuUsage()` is **whole-process**, not
  per-thread, on this Node/platform combination — confirmed empirically:
  main-thread-scoped and worker-thread-scoped diffs over the same wall
  window converge to the same value once measured correctly (an earlier
  periodic-sampling version of this bench had a gap bug that made them look
  different; fixed by diffing once at worker start/stop instead of
  accumulating 2 s samples). We therefore report one combined
  **process CPU % of one core**, not separately-attributed main vs. worker
  cost.
- Producer-side per-frame `ArrayBuffer` copy-then-transfer mirrors
  `stream-writer.ts`'s real `write()` path (copy out of the shared
  camera/shm buffer is architecturally required, not a bench artifact).
- Bounded per-channel queue, `maxQueued=8`, drops counted and never silently
  absorbed (workload-metering.md philosophy). `sourceFps` = the camera's true
  arrival rate (schedule never slows down for backpressure); `writtenFps` =
  frames actually accepted; the gap is `dropPct`.

## Throughput matrix (32 s sustained runs)

| size | compression | sourceFps (each raw) | writtenFps (raw) | dropPct (raw) | writtenFps (processed) | sustained MB/s (logical) | on-disk MB/s | compression ratio | process CPU (% of 1 core / 10) | RSS min–max |
|---|---|---|---|---|---|---|---|---|---|---|
| 1.5 MiB | none | 60.0 | 59.9 | 0.2–0.3% | 30.0 | 275.2 | 275.2 | 1.00 | 56% | 247–267 MB |
| 1.5 MiB | lz4  | 60.0 | 60.0 | 0% | 30.0 | 275.8 | 276.9 | 0.996 (slightly negative) | 61% | 391–411 MB |
| 1.5 MiB | zstd-1 | 60.0 | 60.0 | 0% | 30.0 | 275.8 | 187.8 | 1.469 | 67% | 255–277 MB |
| 6.2 MiB | none | 60.0 | 35.1 | 41.5% | 29.8 | 676.7 | 676.7 | 1.00 | 118% | 507–542 MB |
| 6.2 MiB | lz4  | 60.0 | 31.6 | 47.4% | 29.0 | 610.6 | 613.0 | 0.996 (slightly negative) | 116% | 775–829 MB |
| 6.2 MiB | zstd-1 | 60.0 | 17.7 | 70.6% | 17.5 | 342.2 | 339.0 | 1.009 | 111% | 595–622 MB |

**Nominal demanded raw ingest** (3×60fps, ignoring processed stream): 1.5 MiB
→ 270 MiB/s; 6.2 MiB → 1116 MiB/s.

## What's actually the bottleneck at 6.2 MiB

Not CPU (never exceeds ~120% of a single core out of 10 available — the
machine has enormous compute headroom left) and not raw disk bandwidth (the
`dd` anchor showed ~1.48 GB/s sequential write capacity, comfortably above
the 1.1 GB/s nominal target). The ceiling is the **single serialized
writer**: every `addMessage()` across all 4 channels goes through one
promise chain in one worker: at 6.2 MiB the whole pipeline tops out around
~140–150 total messages/sec regardless of channel mix, which is enough for
the 1.5 MiB tier (240 msg/s target, comfortably under capacity) but well
short of the 6.2 MiB tier's 270 msg/s target. **Compression makes it worse,
not better**, at this size: added CPU per chunk (buffer copy + compress)
lengthens the critical path of the one serialized chain, so lz4 and
especially zstd *increase* drop rate compared to no compression, even though
zstd does eventually shrink the file (ratio 1.47 at 1.5 MiB, but a much
weaker 1.01 at 6.2 MiB — our noisy synthetic 12-bit data has a high entropy
floor, consistent with the spec's "raw Bayer compressibility TBD" caveat).

## Index-based seeking

`McapIndexedReader.Initialize()` (reads the trailing footer + chunk index)
took 4–8 ms regardless of file size (tested up to ~22 GB / 6711 messages /
3362 chunks). A narrow-window `readMessages({startTime, endTime})` seek near
the middle of a file took 3–11 ms — compare to a sampled cost of ~1.7 ms/msg
for a plain sequential scan from the start; the seek is clearly using the
chunk index, not a linear scan (this cost would grow with file size if it
weren't). Verified on 1.5 MiB none/lz4/zstd files and the degraded-throughput
6.2 MiB zstd file. See `src/verify-seek.ts` and `RESULT_SEEK:` lines.

## Crash recovery

`src/crash-recovery.ts` runs a short write session then `worker.terminate()`s
without ever sending `stop` (so `McapWriter.end()` — footer + summary + chunk
index — never runs), simulating a hard process crash mid-recording.

- **`McapIndexedReader.Initialize()` on a crashed file: always fails** — no
  footer means no magic bytes at EOF, and it throws a clear, specific error
  (`Expected MCAP magic ... found ...`). The indexed/seekable path is **not**
  crash-tolerant by itself.
- **`McapStreamReader` (sequential, no footer needed) recovers everything
  that was flushed to disk.** MCAP's `McapWriter` buffers each chunk **fully
  in memory** and only calls the underlying file write once the chunk
  exceeds `chunkSize` (confirmed by reading `McapWriter.js`) — so the loss
  window on crash is bounded by "whatever's in the currently-open,
  not-yet-flushed chunk," not the whole file. With `chunkSize` set to ~1.05×
  a raw frame (our config, aligning chunks to roughly one frame each), that
  loss window measured **at most 1 message** in both test runs (1.5 MiB/none:
  844 sent = 844 acked = 844 recovered, nothing in flight to lose; 6.2
  MiB/zstd, deliberately overloaded: 331 acked, 330 recovered by the
  streaming reader — a 1-message loss at the crash boundary).
- Practical implication: **chunkSize is a tunable dial between crash-loss
  window and chunk/compression overhead** — smaller chunks bound crash loss
  more tightly but mean more per-chunk framing and (for compressed chunks)
  worse compression context; recommend keeping it close to 1 raw frame as
  done here.
- Side finding (not the point of this test, but visible in the harness):
  `crash-recovery.ts`'s producer has **no bounded queue** (unlike
  `bench.ts`), so under overload frames pile up unboundedly in the worker's
  promise chain (1264 sent vs. 331 acked before termination in the 6.2
  MiB/zstd run) — this is exactly why the real recorder design (and
  `bench.ts`) must keep the bounded-queue-with-drop-accounting discipline;
  it is not something MCAP itself provides.

## Dependencies installed (devDependencies, `playground/bench-recorder/package.json` only)

- `@mcap/core@2.2.1`, `@mcap/nodejs@1.1.0` — writer/reader + Node FS glue
- `lz4-napi@2.9.0` — sync lz4 compress/decompress (napi-rs, prebuilt for
  darwin-arm64)
- `zstd-napi@0.0.12` — sync zstd compress/decompress (needed because MCAP's
  `compressChunk` hook is synchronous; `@mongodb-js/zstd` was tried first but
  is async-only and was removed again)

## GO / NO-GO

**Conditional GO.** MCAP comfortably meets the ~1.5 MiB/frame tier (3×60fps
+ 1×30fps, essentially 0% drop, huge CPU/RSS headroom, sub-10ms indexed
seeking, and a well-bounded, well-understood crash-loss window). It does
**not** meet the ~6.2 MiB/frame tier as built (single serialized writer
tops out around 140–150 msg/s, 41-70% drop depending on compression) — that
tier needs either an architecture change (e.g. splitting raw channels across
independent writer workers/files instead of one shared serialized chain,
or a lower per-channel fps/resolution budget at that frame size) before a
verdict can be given at full 6.2 MiB/60fps/3-camera load. Recommend: ship
MCAP as the container format (format itself is not the bottleneck — a
single-writer-thread serialization choice is), and treat "how many writer
workers / files per recording session at the largest frame size" as a
follow-up spec question rather than a reason to fall back to Plan-B's custom
container.
