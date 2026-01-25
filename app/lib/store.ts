// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, zhangyuxuan@ufl.edu
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { TypedArray } from "core/types";
import { ipcRenderer } from "electron";
import { existsSync } from "node:fs";
import {
    mkdir,
    readdir,
    readFile,
    writeFile,
    stat,
    rm,
} from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { reactive, watch } from "vue";

const STORE: string = resolve(
    await ipcRenderer.invoke("get-data-path"),
    "store",
);

process.stderr.write(`Store path: ${STORE}\n`);

async function isDirectory(path: string) {
    try {
        const stats = await stat(path);
        return stats.isDirectory();
    } catch {
        return false;
    }
}

const TypedArrayConstructors = {
    Uint8Array,
    Uint8ClampedArray,
    Int8Array,
    Uint16Array,
    Int16Array,
    Uint32Array,
    Int32Array,
    Float32Array,
    Float64Array,
    BigInt64Array,
    BigUint64Array,
};

function ownProperties(value: any) {
    let flag = false;
    const result: Record<string, any> = {};
    for (const key of Object.getOwnPropertyNames(value)) {
        // Skip numeric indices (array-like indexed properties)
        if (/^\d+$/.test(key)) continue;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        // Only include writable, enumerable properties that were assigned
        if (descriptor && descriptor.writable && descriptor.enumerable) {
            result[key] = (value as any)[key];
            flag = true;
        }
    }
    return flag ? result : undefined;
}

function toBase64(buffer: ArrayBufferLike): string {
    const bytes = new Uint8Array(buffer);
    let binary = "";
    for (let i = 0; i < bytes.byteLength; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function fromBase64(str: string): ArrayBuffer {
    const binary = atob(str);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes.buffer;
}

type Deflated<T = {}> = T & {
    type: string;
    props?: Record<string, any>;
};

function replacer(key: string, value: any) {
    if (typeof value === "bigint") {
        return {
            type: "bigint",
            value: value.toString(),
        };
    }
    if (typeof value !== "object" || value === null) return value;
    if (value instanceof Date) {
        return {
            type: "Date",
            date: value.toISOString(),
        };
    }
    if (value instanceof ArrayBuffer) {
        return {
            type: "ArrayBuffer",
            buffer: toBase64(value),
            props: ownProperties(value),
        };
    }
    for (const [k, c] of Object.entries(TypedArrayConstructors)) {
        if (value instanceof c) {
            return {
                type: k,
                buffer: toBase64((value as TypedArray).buffer),
                props: ownProperties(value),
            };
        }
    }
    return value;
}

function reviver(key: string, value: any) {
    if (typeof value !== "object" || value === null) return value;
    const { type, props = {} } = value as Deflated;
    if (type === "bigint") {
        const { value: val } = value as Deflated<{ value: string }>;
        return BigInt(val);
    }
    if (type === "Date") {
        const { date } = value as Deflated<{ date: string }>;
        return new Date(date);
    }
    if (type === "ArrayBuffer") {
        const { buffer } = value as Deflated<{ buffer: string }>;
        const arr = fromBase64(buffer);
        Object.assign(arr, props);
        return arr;
    }
    if (type in TypedArrayConstructors) {
        const ctor = (TypedArrayConstructors as any)[type];
        const { buffer } = value as Deflated<{ buffer: string }>;
        const arr = new ctor(fromBase64(buffer));
        Object.assign(arr, props);
        return arr;
    }
    return value;
}

export default class Store {
    private static readonly registry = new Map<string, WeakRef<Object>>();
    private static track<T extends Object>(obj: Partial<T>, path: string) {
        const tracked = reactive(obj);
        let writePending = false;
        const queueWrite = () => {
            if (writePending) return;
            writePending = true;
            process.nextTick(() => {
                writePending = false;
                this.save(tracked, path);
            });
        };
        watch(() => tracked, queueWrite, { deep: true });
        this.registry.set(path, new WeakRef(tracked));
        return tracked as Partial<T>;
    }
    private static resolveStorePath(tracked: Object) {
        for (const [path, ref] of this.registry) {
            const obj = ref.deref();
            if (obj === tracked) return path;
        }
        throw new Error("Object is not a store instance");
    }
    static async open<T extends Object>(
        segments: string | string[],
        fallback: Partial<T> = {},
    ): Promise<Partial<T>> {
        if (typeof segments === "string") segments = [segments];
        const path = resolve(STORE, ...segments) + ".json";
        if (this.registry.has(path)) {
            const entry = this.registry.get(path)!.deref();
            if (entry !== undefined) return entry as Partial<T>;
            else this.registry.delete(path);
        }
        if (!existsSync(path)) return this.track(fallback, path);
        if (await isDirectory(path))
            throw new Error(`Store ${path} is a directory`);
        // If read failed, error should propagate out.
        const file = await readFile(path);
        try {
            return this.track<T>(JSON.parse(file.toString(), reviver), path);
        } catch (error) {
            process.stderr.write(`Error loading store data: ${error}\n`);
            return this.track<T>(fallback, path);
        }
    }
    static clear(store: Object): Promise<void>;
    static clear(...segments: string[]): Promise<void>;
    static async clear(seg: string | object, ...segments: string[]) {
        const path =
            typeof seg === "object"
                ? this.resolveStorePath(seg)
                : resolve(STORE, seg, ...segments);
        // clear object in registry, if exists
        if (this.registry.has(path)) {
            const entry = this.registry.get(path)!.deref();
            if (entry !== undefined) {
                for (const key of Object.keys(entry)) {
                    delete (entry as any)[key];
                }
            }
        }
        // remove file
        try {
            await rm(path, { force: true });
        } catch (error) {
            process.stderr.write(`Error removing store data: ${error}\n`);
        }
    }
    static async list(...segments: string[]) {
        const path = resolve(STORE, ...segments);
        if (!existsSync(path)) return [];
        if (!(await isDirectory(path)))
            throw new Error(`Store ${path} is not a directory`);
        const entries = await readdir(path);
        const files = await Promise.all(
            entries.map(async (entry) => {
                const fullPath = resolve(path, entry);
                if (await isDirectory(fullPath)) return null;
                return entry.replace(/\.json$/, "");
            }),
        );
        return files.filter((f): f is string => f !== null);
    }
    static async save(data: any, path?: string) {
        path ??= this.resolveStorePath(data);
        const dir = dirname(path);
        if (!existsSync(dir)) {
            await mkdir(dir, { recursive: true });
        }
        await writeFile(path, JSON.stringify(data, replacer, 2));
    }
}
