// ------------------------------------------------------
// Copyright (c) 2026 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
//
// The `viewer` session (C-8) — the data layer behind the viewer windows
// (A-11 builds the UI against the same pinned contract in
// `@lib/orchestrator/viewer-contract`). Opens `.fovea` containers (indexed,
// with the streaming re-index fallback for crash-truncated files), keys
// everything by fileId so multiple containers play concurrently, and replays
// frames through the STANDARD session frame transport — frame name
// `<fileId>:<channel>` → wire topic `fr:viewer:<fileId>:<channel>`, shm
// rings and all, so a viewer window consumes playback exactly like a live
// stream. No camera, no serial: this session never joins the camera-owning
// drain set; viewer windows survive app switches by design.
//
// Each open file registers a `viewer:<fileId>` workload meter (per-channel
// ingest, frames/telemetry out, late/undecodable drops) — disposed on close.

import { defineSession, type ServerSession } from "../runtime.js";
import {
  viewer,
  type PlaybackDoc,
  type ViewerFile,
} from "@lib/orchestrator/viewer-contract";
import { registerWorkload } from "../metering.js";
import { createFrameDecoder, type FrameDecoder } from "../viewer/decode.js";
import {
  createPlayer,
  type Player,
  type PlayerClock,
} from "../viewer/player.js";
import { openFovea, type FoveaChannel, type FoveaSource } from "../viewer/source.js";

/** Injection seams for the unit harness (real defaults in production):
 *  `open` swaps the file layer, `decoderFor` avoids loading core Vision in
 *  tests, `clock` makes pacing deterministic. */
export interface ViewerSessionDeps {
  open?: (path: string) => Promise<FoveaSource>;
  decoderFor?: (channel: FoveaChannel) => Promise<FrameDecoder>;
  clock?: PlayerClock;
}

interface OpenFile {
  player: Player;
  /** The static half of the `ViewerFile` state row. */
  info: Omit<ViewerFile, "positionNs" | "playing">;
  positionNs: number;
  playing: boolean;
}

export function viewerSession(deps: ViewerSessionDeps = {}): ServerSession<typeof viewer> {
  const openSource = deps.open ?? openFovea;
  const decoderFor =
    deps.decoderFor ?? ((channel: FoveaChannel) => createFrameDecoder(channel.metadata));

  return defineSession("viewer", viewer, (s) => {
    const files = new Map<string, OpenFile>();
    const playbackDocs: Record<string, PlaybackDoc | null> = {};
    let nextId = 1;

    function pushFiles(): void {
      const snapshot: Record<string, ViewerFile> = {};
      for (const [id, f] of files)
        snapshot[id] = { ...f.info, positionNs: f.positionNs, playing: f.playing };
      s.setState("files", snapshot);
    }

    function required(fileId: string): OpenFile {
      const f = files.get(fileId);
      if (!f) throw new Error(`viewer: unknown fileId "${fileId}"`);
      return f;
    }

    async function closeFile(fileId: string): Promise<void> {
      const f = files.get(fileId);
      if (!f) return;
      files.delete(fileId);
      delete playbackDocs[fileId];
      await f.player.close(); // also disposes the file's workload meter
      pushFiles();
      s.telemetry({ playback: { ...playbackDocs } });
    }

    return {
      // Last viewer window gone → release every reader/meter. Passive
      // observers (profiler, V12) never trigger this.
      idle() {
        return Promise.all([...files.keys()].map(closeFile)).then(() => undefined);
      },

      commands: {
        async open(path: string): Promise<{ fileId: string }> {
          const source = await openSource(path);
          const fileId = `f${nextId++}`;
          const workload = registerWorkload(`viewer:${fileId}`, {
            inputs: source.channels.map((c) => c.topic),
            outputs: ["frames", "telemetry"],
          });
          const entry: OpenFile = {
            positionNs: 0,
            playing: false,
            info: {
              path,
              channels: source.channels.map((c) => ({
                name: c.topic,
                metadata: c.metadata,
              })),
              durationNs: Number(source.endNs - source.startNs),
              truncated: source.truncated,
            },
            // Assigned right below — createPlayer needs the hooks first.
            player: null as unknown as Player,
          };
          entry.player = createPlayer(
            source,
            decoderFor,
            workload,
            {
              publishFrame: (channelTopic, mat, convertMs) =>
                s.frame(`${fileId}:${channelTopic}`, mat, {
                  tCapture: Date.now(),
                  convertMs,
                }),
              publishTelemetry: (doc) => {
                playbackDocs[fileId] = doc;
                s.telemetry({ playback: { ...playbackDocs } });
              },
              onUpdate: (positionNs, playing) => {
                entry.positionNs = positionNs;
                entry.playing = playing;
                pushFiles();
              },
            },
            deps.clock,
          );
          files.set(fileId, entry);
          pushFiles();
          return { fileId };
        },

        async close(fileId: string): Promise<void> {
          await closeFile(fileId);
        },

        async seek({ fileId, tNs }: { fileId: string; tNs: number }): Promise<void> {
          await required(fileId).player.seek(tNs);
        },

        async play({ fileId, rate }: { fileId: string; rate: number }): Promise<void> {
          required(fileId).player.play(rate);
        },

        async pause(fileId: string): Promise<void> {
          required(fileId).player.pause();
        },
      },
    };
  });
}
