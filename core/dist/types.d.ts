export type Awaitable<T> = T | Promise<T>;

export type BufferLike = Buffer | ArrayBuffer | ArrayBufferView;

export type TypedArray =
    | Int8Array
    | Uint8Array
    | Uint8ClampedArray
    | Int16Array
    | Uint16Array
    | Int32Array
    | Uint32Array
    | Float32Array
    | Float64Array
    | BigInt64Array
    | BigUint64Array;

export class CoreObject<T extends CoreObject<T>> {
    /**
     * Hex string ID of the underlying native object.
     * Can be used to check if two JS objects point to the same native object.
     */
    readonly id: string;
    /**
     * Creates another reference to the same underlying native object.
     * Releasing either reference will not affect the other.
     */
    public ref(): T;
    /**
     * Releases underlying native resources.
     * After calling release(), any further access to the object will throw an error.
     * It is safe to call release() multiple times.
     */
    public release(): void;
}

export class Stream<T> extends CoreObject<Stream<T>> {
    // Skip frames if the consumer is slower than the producer.
    // Generates null if consumer is faster than producer.
    // Consumer MUST yield (await) upon null so producer can push data.
    [Symbol.iterator](): IterableIterator<T | null>;
    // Queue frames for the consumer, with a bounded native backlog.
    // If the consumer falls behind, stale queued frames may be dropped.
    [Symbol.asyncIterator](): AsyncIterableIterator<T>;
}

// ---- Native port/pipe substrate (docs/proposals/native-port-pipe.md) --------

/**
 * Per-link-type options (ruled discriminated union — per-type params cannot
 * cross): `latest` = latest-wins shedding (default); `fifo` = lossless bounded
 * blocking queue with producer backpressure (`depth`, default 8); `ring` =
 * bounded drop-oldest, non-blocking producer (`size`, default 8). Validated
 * again NAPI-side (named errors) — runtime and compile time agree.
 */
export type LinkOptions =
    | { type: "latest" }
    | { type: "fifo"; depth?: number }
    | { type: "ring"; size?: number };

/** `link.probe()` snapshot — plain-atomic counters probed out-of-loop. */
export interface LinkProbe {
    type: "latest" | "fifo" | "ring";
    /** Channel bound (1 for latest; depth/size otherwise). */
    capacity: number;
    /** Items the producer pushed into the channel. */
    written: number;
    /** Items the delivery thread handed to the consumer sink. */
    delivered: number;
    /** Shed items (latest: superseded; ring: overwritten; fifo: always 0). */
    dropped: number;
    /** Peak queue occupancy (fifo/ring); 1 for latest. */
    highWater: number;
    /** False once released or the producer stream terminated. */
    open: boolean;
}

/**
 * A live native thread-to-thread link returned by {@link OutPort.pipe}. Its
 * edge self-registers in `Topology.report()` at connect and retires at
 * `release()` — piped edges show on the profiler graph without any
 * session-side wiring shim. `release()` (the CoreObject release) is the
 * idempotent disconnect; resizing/retyping is NOT supported — release and
 * re-pipe. The link pins both bricks' native streams while connected.
 */
export interface PortLink extends CoreObject<PortLink> {
    probe(): LinkProbe;
}

/**
 * A brick's typed OUT port (`<name>_out` accessor — lazily created, cached).
 * `T` is a phantom payload brand (the `cmd<Arg, Ret>()` precedent): piping
 * into an {@link InPort} of a different payload fails vue-tsc; the runtime
 * re-checks the tag strings at pipe() time (JS TypeError).
 */
export interface OutPort<T> extends CoreObject<OutPort<T>> {
    /** Producer node id (= the brick's meter/graph name). */
    readonly node: string;
    /** Port name (the topology edge's producer-side name). */
    readonly port: string;
    /** Runtime stream tag (must equal the target in-port's tag). */
    readonly streamTag: string;
    /** Connect natively to a matching in-port (default link type "latest"). */
    pipe(target: InPort<T>, opts?: LinkOptions): PortLink;
}

/** A brick's typed IN port (`<name>_in` accessor — lazily created, cached).
 *  The phantom brand is REQUIRED (never materialized at runtime — in-ports
 *  only ever come from d.ts-typed accessors): an optional brand would let an
 *  OutPort structurally satisfy InPort, and the ruled out→out `pipe()` case
 *  must fail vue-tsc. */
export interface InPort<T> extends CoreObject<InPort<T>> {
    readonly node: string;
    /** Port name — becomes the consumer-side edge port on the graph. */
    readonly port: string;
    readonly streamTag: string;
    /** Phantom payload brand only — never materialized at runtime. Function-
     *  typed so `T` sits in BOTH variance positions (invariant): structurally
     *  overlapping payloads (e.g. ImmPrediction ⊃ TrackResult) must not
     *  unify across lanes — the runtime tags would reject what a covariant
     *  brand would let compile. */
    readonly __payload: (payload: T) => T;
}

/** The `compose.volt_out → controller.pos_in` link payload (native-compose-
 *  controller.md): a commanded per-eye mirror pose in FINAL volts. Phantom
 *  brand for the port harness; runtime tag "volts". */
export interface MirrorVolts {
    left: { x: number; y: number };
    right: { x: number; y: number };
}
