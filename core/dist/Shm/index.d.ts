declare module "core/Shm" {
  export type ShmFrameMeta = {
    tCapture?: number;
    convertMs?: number;
    deviceTimestamp?: bigint;
    systemTimestamp?: bigint;
  };

  export type ShmDescriptor = {
    shape: number[];
    channels: number;
    meta?: ShmFrameMeta;
    shm: {
      seg: string;
      gen: number;
      seq: bigint;
    };
  };

  export class ShmSlot {
    private constructor();
    /** ⚠ Under Electron's V8 memory cage this is a READ SNAPSHOT (a
     *  cage-local copy) — writing into it never reaches shared memory.
     *  Use `write()` to publish pixels and `copyTo()` to read into a
     *  reusable buffer. Only non-cage (plain Node) builds return a live
     *  view over the slot. */
    view(): import("core/Vision").Mat<Uint8Array>;
    /** Native size-checked memcpy INTO the slot (cage-safe on every
     *  runtime). Source byte length must equal the slot's byte size. */
    write(src: ArrayBufferView): void;
    /** Native memcpy OUT of the slot into `dest` (must be at least the
     *  slot's byte size). Returns bytes copied. Intended for serving
     *  in-process taps from one persistent buffer. */
    copyTo(dest: Uint8Array): number;
    debugFillPattern(seed: number): void;
  }

  export class Writer {
    constructor(key: string);
    nextSlot(shape: number[], channels: number): ShmSlot;
    publish(meta?: ShmFrameMeta): ShmDescriptor;
    close(): void;
  }

  export function topicKey(topic: string): string;
  export function sweep(): number;
}
