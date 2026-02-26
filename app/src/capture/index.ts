// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { mkdirSync } from "node:fs";
import fs from "node:fs/promises";
import { resolve } from "node:path";
import { homedir } from "node:os";
import { cvtColor, type Mat } from "core/Vision";
import { onScopeDispose, reactive, ref, shallowRef } from "vue";
import { Vision } from "core";

function RGB2BGR(image: Mat) {
  switch (image.channels) {
    case 4:
      return cvtColor(image, "RGBA2BGRA");
    case 3:
      return cvtColor(image, "RGB2BGR");
    default:
      return image;
  }
}

export type MetaResource = Object;
export type ImageResource = Mat;
export type Resource = {
  meta?: MetaResource | null;
  image?: ImageResource | null;
};
type Provide = (name: string, data: Resource | Resource[]) => void;
type Provider = (provide: Provide) => any;
type Context = { namespace: string; providers: Provider[] };
export type CaptureData = Map<string, Resource | Resource[]>;
export type SaveState = Map<string, Promise<any> | Promise<any>[]>;
const context = shallowRef<Context | null>(null);

export function register(namespace: string, ...providers: Provider[]) {
  if (context.value)
    throw new Error(
      `Context already exists for namespace "${context.value.namespace}".`,
    );
  const ctx = { namespace, providers };
  context.value = ctx;
  const revoke = () => {
    if (context.value === ctx) context.value = null;
  };
  onScopeDispose(revoke);
  return revoke;
}

export const current_capture = shallowRef<Capture | null>(null);

// YYYYMMDD-HHMMSS
function getDateTimeString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  const hours = String(now.getHours()).padStart(2, "0");
  const minutes = String(now.getMinutes()).padStart(2, "0");
  const seconds = String(now.getSeconds()).padStart(2, "0");
  return `${year}${month}${day}-${hours}${minutes}${seconds}`;
}

export class CaptureAborted extends Error {}

export default class Capture {
  private seq = 1;
  get sequence() {
    return this.seq.toString().padStart(4, "0");
  }
  updateSequence(s: string) {
    if (!/\d+/.test(s)) return;
    this.seq = parseInt(s) + 1;
  }
  readonly prefix = getDateTimeString();
  get directory() {
    return `${this.prefix}.${this.namespace}`;
  }

  private __last_save_path = ref<string | null>(null);
  get default_path() {
    return resolve(homedir(), "Downloads", this.directory);
  }
  get current_path() {
    return this.__last_save_path.value ?? this.default_path;
  }
  set current_path(path: string) {
    path = path.trim();
    if (path === "" || path === this.default_path)
      this.__last_save_path.value = null;
    else this.__last_save_path.value = path;
  }
  resetPath() {
    this.__last_save_path.value = null;
  }

  private readonly providers = new Set<Provider>();
  constructor(public readonly namespace: string) {
    if (current_capture.value !== null)
      throw new Error(
        `A capture is already in progress for namespace "${current_capture.value.namespace}".`,
      );
    current_capture.value = this;
    onScopeDispose(() => this.dispose());
  }

  dispose() {
    this.providers.clear();
    if (current_capture.value === this) current_capture.value = null;
  }

  provide(provider: Provider) {
    this.providers.add(provider);
    const revoke = () => this.providers.delete(provider);
    onScopeDispose(revoke);
    return revoke;
  }

  delegate(name: string) {
    return (handler: () => Awaitable<Resource | Resource[] | null>) => {
      return this.provide(async (provide) => {
        const data = await handler();
        if (data !== null) provide(name, data);
      });
    };
  }

  capture(cap: CaptureData = new Map()) {
    let aborted = false;
    const provide = (name: string, data: Resource | Resource[]) => {
      if (aborted) throw new CaptureAborted();
      if (!cap.has(name))
        cap.set(name, Array.isArray(data) ? reactive([...data]) : data);
      else {
        const existing = cap.get(name)!;
        if (Array.isArray(data) && Array.isArray(existing))
          existing.push(...data);
        else if (!Array.isArray(data) && !Array.isArray(existing))
          Object.assign(existing, data);
        else
          throw new Error(
            `Resource type mismatch for "${name}": ${{ existing, incoming: data }}`,
          );
      }
    };
    return Object.assign(
      Promise.all(
        Array.from(this.providers).map(async (provider) => {
          try {
            return await provider(provide);
          } catch (e) {
            if (e instanceof CaptureAborted) return;
            else throw e;
          }
        }),
      ).then(() => cap),
      {
        abort() {
          aborted = true;
        },
      },
    );
  }

  save(path: string, data: CaptureData, img_format: string = "png") {
    // Create directory if not exists
    mkdirSync(path, { recursive: true });
    const tasks: SaveState = new Map();
    for (const [name, items] of data.entries()) {
      if (Array.isArray(items)) {
        // Save in child folder
        const directory = resolve(path, name);
        mkdirSync(directory, { recursive: true });
        const pad = Math.max(2, items.length.toString().length);
        const dir_tasks: Promise<any>[] = [];
        for (const [i, { meta, image }] of items.entries()) {
          const sequence = i.toString().padStart(pad, "0");
          if (meta)
            dir_tasks.push(
              fs.writeFile(
                resolve(directory, `${sequence}.json`),
                JSON.stringify(meta, null, 2),
              ),
            );
          if (image) {
            const img_path = resolve(directory, `${sequence}.${img_format}`);
            dir_tasks.push(Vision.save(RGB2BGR(image), img_path));
          }
        }
        tasks.set(name, dir_tasks);
      } else {
        const { meta, image } = items;
        if (meta) {
          const json_path = resolve(path, `${name}.json`);
          tasks.set(
            json_path,
            fs.writeFile(json_path, JSON.stringify(meta, null, 2)),
          );
        }
        if (image) {
          const img_path = resolve(path, `${name}.${img_format}`);
          tasks.set(img_path, Vision.save(RGB2BGR(image), img_path));
        }
      }
    }
    return tasks;
  }
}

export type Delegation = ReturnType<Capture["delegate"]>;
