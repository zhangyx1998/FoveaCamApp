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
