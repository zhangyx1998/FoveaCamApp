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
    debugFillPattern(seed: number): void;
  }

  export class Writer {
    constructor(key: string);
    nextSlot(shape: number[], channels: number): ShmSlot;
    publish(meta?: ShmFrameMeta): ShmDescriptor;
    close(): void;
  }

  export function sweep(): number;
}
