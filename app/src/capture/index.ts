// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import fs from "node:fs";
import { resolve } from "node:path";
import { cvtColor, type Mat } from "core/Vision";
import { shallowReactive } from "vue";
import { Vision } from "core";

function makeBGR(image: Mat<Uint8Array>) {
  switch (image.channels) {
    case 4:
      return cvtColor(image, "RGBA2BGRA");
    case 3:
      return cvtColor(image, "RGB2BGR");
    default:
      return image;
  }
}

type Provider<T> = () => T | null;
type Meta = Record<string, any>;
type Revoke = (() => any) & {
  meta: (name: string, data: () => Record<string, any> | null) => Revoke;
  image: (name: string, data: () => Mat<Uint8Array> | null) => Revoke;
};

function getOrCreateSet<T>(
  map: Map<string, Set<Provider<T>>>,
  name: string,
): Set<Provider<T>> {
  if (!map.has(name)) {
    map.set(name, new Set());
  }
  return map.get(name)!;
}

function registerProvider<T>(
  map: Map<string, Set<Provider<T>>>,
  name: string,
  provider: Provider<T>,
  revoke?: () => any,
): () => any {
  const set = getOrCreateSet(map, name);
  set.add(provider);
  return () => {
    revoke?.();
    set.delete(provider);
    if (set.size === 0 && map.get(name) === set) map.delete(name);
  };
}

export default class Capture {
  static readonly metaProviders = shallowReactive(
    new Map<string, Set<Provider<Meta>>>(),
  );
  static readonly imageProviders = shallowReactive(
    new Map<string, Set<Provider<Mat<Uint8Array>>>>(),
  );
  static meta(
    name: string,
    data: () => Record<string, any> | null,
    _revoke?: () => any,
  ): Revoke {
    const revoke = registerProvider(this.metaProviders, name, data, _revoke);
    return Object.assign(revoke, {
      meta(name: string, data: () => Record<string, any> | null) {
        return Capture.meta(name, data, revoke);
      },
      image(name: string, data: () => Mat<Uint8Array> | null) {
        return Capture.image(name, data, revoke);
      },
    });
  }
  static image(
    name: string,
    data: () => Mat<Uint8Array> | null,
    _revoke?: () => any,
  ): Revoke {
    const revoke = registerProvider(this.imageProviders, name, data, _revoke);
    return Object.assign(revoke, {
      meta(name: string, data: () => Record<string, any> | null) {
        return Capture.meta(name, data, revoke);
      },
      image(name: string, data: () => Mat<Uint8Array> | null) {
        return Capture.image(name, data, revoke);
      },
    });
  }

  readonly meta = new Map<string, Record<string, any>>();
  readonly image = new Map<string, Array<Mat<Uint8Array>> | Mat<Uint8Array>>();
  constructor() {
    for (const [name, providers] of Capture.metaProviders) {
      const meta = {} as Record<string, any>;
      for (const provider of providers) {
        const data = provider();
        if (data) {
          Object.assign(meta, data);
        }
      }
      this.meta.set(name, meta);
    }
    for (const [name, providers] of Capture.imageProviders) {
      if (providers.size === 1) {
        for (const provider of providers) {
          const image = provider();
          if (image) {
            this.image.set(name, image);
          }
        }
      } else {
        const images: Array<Mat<Uint8Array>> = [];
        for (const provider of providers) {
          const image = provider();
          if (image) {
            images.push(image);
          }
          this.image.set(name, images);
        }
      }
    }
  }
  save(path: string, img_format: string = "png") {
    // Create directory if not exists
    fs.mkdirSync(path, { recursive: true });
    // Save meta
    for (const [name, data] of this.meta) {
      const jsonPath = resolve(path, name + ".json");
      console.log("Saving meta to", jsonPath);
      fs.writeFileSync(jsonPath, JSON.stringify(data, null, 2), "utf-8");
    }
    // Save images
    for (const [name, images] of this.image) {
      if (Array.isArray(images)) {
        const directory = resolve(path, name);
        fs.mkdirSync(directory, { recursive: true });
        const digits = Math.max(2, images.length.toString().length);
        images.forEach((image, index) => {
          const sequence = index.toString().padStart(digits, "0");
          const imgPath = resolve(directory, `${sequence}.${img_format}`);
          console.log("Saving image to", imgPath);
          Vision.save(makeBGR(image), imgPath);
        });
      } else {
        const imgPath = resolve(path, `${name}.${img_format}`);
        console.log("Saving image to", imgPath);
        Vision.save(makeBGR(images), imgPath);
      }
    }
  }
}
