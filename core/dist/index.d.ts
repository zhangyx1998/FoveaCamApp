// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
declare module "core" {
    /** Path to the resolved native module injected by JS loader */
    export const __origin__: string;

    // Explicitly cleanup all resources (cameras, streams, frames, etc.)
    export function cleanup(): void;

    /**
     * Install native crash-site tracing (teardown-hardening): a
     * `std::set_terminate` hook plus SIGABRT/SIGSEGV/SIGBUS handlers that print
     * a symbolicatable native backtrace (and, for terminate, the uncaught
     * exception message) to stderr, then RE-RAISE so the process still dies with
     * the same signal / exit code (exit 6 still triggers the janitor). Idempotent
     * — call once at orchestrator-process boot.
     */
    export function installCrashHandler(): void;

    /**
     * THE native host time authority (unified-time §1): libc++
     * `std::chrono::steady_clock` as integer nanoseconds (bigint). Every
     * clock-calibration offset the native layer computes/stores — and every
     * OWNER-APPLIED frame timestamp on a calibrated camera — is in THIS
     * domain. JS time code must delegate here instead of `hrtime.bigint()`
     * (not guaranteed the same Darwin clock domain): one authority only.
     */
    export function steadyNowNs(): bigint;

    /**
     * native-recorder Wave 2: the live RECORDER BRICK (hand-rolled C++ MCAP
     * writer + free-running writer thread fed by producer-seam record taps).
     * Driven by `@orchestrator/recorder-node` — nothing per-frame crosses this
     * boundary. Handle-based; all fovea schema/metadata constants are passed IN
     * (docs/schema stays the single source of truth).
     */
    /**
     * Native port/pipe substrate (docs/proposals/native-port-pipe.md) —
     * root-object-only namespace (the Recorder precedent). Production ports
     * hang off brick objects (`tracker.track_out`, `imm.measure_in`); this
     * namespace carries the class registrations + the HARDWARE-FREE test
     * hooks core/test/44 and 42 drive.
     */
    export namespace Port {
        /** Push-driven TrackResult source with a `track_out` port (tag
         *  "track"). Test-only. */
        function createTestTrackSource(nodeId: string): {
            readonly track_out: import("./types").OutPort<
                import("core/Tracker").TrackResult
            >;
            push(result: {
                found: boolean;
                overridden?: boolean;
                center: { x: number; y: number } | null;
                bbox?: { x: number; y: number; width: number; height: number } | null;
                seq?: number;
                deviceTimestamp?: bigint;
            }): void;
            release(): void;
        };
        /** Counting TrackResult sink with a `track_in` port. `tag` overrides
         *  the runtime tag (mismatch tests); `port` names the edge port
         *  (default "measure"). Test-only. */
        function createTestTrackSink(
            nodeId: string,
            tag?: string,
            port?: string,
        ): {
            readonly track_in: import("./types").InPort<
                import("core/Tracker").TrackResult
            >;
            count(): number;
            seqs(): number[];
            stall(ms: number): void;
            release(): void;
        };
    }

    export namespace Recorder {
        /** Cumulative per-stream counters (recorder-node StreamCounters shape:
         *  written + dropped == ingested; droppedQueue + droppedRing == dropped). */
        interface StreamCounters {
            ingested: number;
            dropped: number;
            droppedQueue: number;
            droppedRing: number;
            written: number;
            bytes: number;
        }
        /** A per-frame write notice (ruling-3 extras dispatch), drained by the
         *  host's low-rate poll and correlated by stream+seq. */
        interface FrameNotice {
            stream: string;
            seq: number;
            logTimeNs: bigint;
            tNs: bigint;
        }
        interface CreateOptions {
            id: string;
            filePath: string;
            chunkBytes: number;
            maxQueuedFrames: number;
            profile: string;
            library: string;
            sessionMetaName: string;
            wideCameraMetaName: string;
            finalizeMetaName: string;
            session: Record<string, string>;
            cameraMatrix?: Record<string, string>;
            rawFrameSchemaName: string;
            rawFrameSchemaData: string;
            descriptorSchemaName: string;
            descriptorSchemaData: string;
            telemetrySchemaName: string;
            telemetrySchemaData: string;
            schemaEncoding: string;
            rawFrameEncoding: string;
            descriptorEncoding: string;
            telemetryEncoding: string;
            telemetryTopic: string;
        }
        /** Open the container (session/wide-camera metadata + telemetry channel
         *  written up front), spawn the writer thread. Returns the handle. */
        function create(opts: CreateOptions): number;
        /** Tap `pipeId`'s publisher, record it as channel `name`. `metadata` is
         *  copied VERBATIM into the MCAP channel (advert-verbatim, ruling 8).
         *  Throws on unknown pipe / duplicate live name / after finalize. */
        function addStream(
            handle: number,
            name: string,
            pipeId: string,
            metadata: Record<string, string>,
            wantsExtras: boolean,
        ): void;
        /** Detach the tap; queued frames still write; the channel stays. */
        function removeStream(handle: number, name: string): void;
        function addDataStream(handle: number, name: string): void;
        function removeDataStream(handle: number, name: string): void;
        function postData(handle: number, name: string, payloadJson: string): void;
        /** Ruling-3 telemetry extras: one doc on the telemetry channel with the
         *  OWNING frame's seq + container-axis logTime. */
        function appendTelemetry(
            handle: number,
            seq: number,
            logTimeNs: bigint,
            payloadJson: string,
        ): void;
        function takeNotices(handle: number): FrameNotice[];
        function stats(handle: number): Record<string, StreamCounters>;
        /** The writer thread's profiling metric block (same snapshot shape as
         *  every other native brick probe). */
        function probe(handle: number): unknown;
        /** R-1 finalize: detach every tap, drain the queue snapshot, write the
         *  summary/footer. Resolve AFTER the writer finished; call destroy()
         *  only after this promise settles. */
        function finalize(
            handle: number,
            durationSec: number,
        ): Promise<{ messageCount: bigint; chunkCount: number; bytes: number }>;
        /** Crash-shape stop (no footer); unblocks a pending finalize. */
        function abort(handle: number): void;
        /** Join + free. Only after the finalize promise settled. */
        function destroy(handle: number): void;
    }

    export * as Aravis from "core/Aravis";
    export * as Controller from "core/Controller";
    export * as Vision from "core/Vision";
    export * as Tracker from "core/Tracker";
    export * as Regression from "core/Regression";
    export * as Geometry from "core/Geometry";
    export * as Compression from "core/Compression";
    export * as Log from "core/Log";
    export * as Shm from "core/Shm";
    export * as Pipe from "core/Pipe";
    export * as Topology from "core/Topology";
}
