// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { markRaw } from "vue";
import { Awaitable } from "../types";

import { defer, Deferred } from ".";

export class AsyncChain<T = any> {
    // Value is only valid when next is an AsyncChain node.
    readonly value?: T;
    readonly next: Awaitable<AsyncChain<T> | null>;
    protected resolve: (value: AsyncChain<T> | null) => void;

    constructor() {
        const { promise, resolve } = defer<AsyncChain<T> | null>();
        this.next = promise;
        this.resolve = resolve;
        markRaw(this);
    }

    static async *iter<T>(node: AsyncChain<T>) {
        while (true) {
            if (node.type === "PENDING") await node.next;
            if (node.type === "END") break;
            yield node.value!;
            node = node.next as AsyncChain<T>;
        }
    }

    [Symbol.asyncIterator]() {
        // AsyncChain relies on JavaScript GC Engine to reclaim resources.
        // However, class method holds reference to a node via `this`, the
        // extra closure is therefore used to avoid memory leak.
        return AsyncChain.iter<T>(this);
    }

    get type() {
        if (this.next instanceof Promise) return "PENDING";
        return this.next === null ? "END" : "DATA";
    }

    *current_items() {
        let node: AsyncChain<T> = this;
        while (node.type === "DATA") {
            yield node.value!;
            node = node.next as AsyncChain<T>;
        }
    }

    get current_length() {
        let count = 0;
        for (const _ of this.current_items()) count++;
        return count;
    }

    get back() {
        let node: AsyncChain<T> = this;
        while (node.type === "DATA") {
            node = node.next as AsyncChain<T>;
        }
        return node;
    }

    push(value: T) {
        const { back } = this;
        (back.value as T) = value;
        const next = new AsyncChain<T>();
        (back.next as AsyncChain<T>) = next;
        back.resolve(next);
        return next;
    }

    terminate() {
        const { back } = this;
        if (back.type === "PENDING") {
            back.resolve(null);
        }
    }
}

export class Latest<T = any> implements AsyncIterable<T>, AsyncIterator<T> {
    private open = true;
    private available = false;
    private current?: T;
    private pending: Deferred<IteratorResult<T>>[] = [];
    [Symbol.asyncIterator]() {
        return this;
    }
    async next(): Promise<IteratorResult<T>> {
        if (!this.open) {
            return Promise.resolve({ value: null, done: true });
        } else if (this.available) {
            const value = this.current!;
            delete this.current;
            this.available = false;
            return Promise.resolve({ value, done: false });
        } else {
            const deferred = defer<IteratorResult<T>>();
            this.pending.push(deferred);
            return deferred.promise;
        }
    }
    push(value: T) {
        if (!this.open) return;
        if (this.pending.length > 0) {
            const p = this.pending.shift()!;
            p.resolve({ value, done: false });
        } else {
            this.current = value;
            this.available = true;
        }
    }
    close() {
        this.open = false;
        for (const p of this.pending) {
            p.resolve({ value: undefined, done: true });
        }
        this.pending = [];
    }
}

export function combinations<T>(arr: T[], k: number = 2): T[][] {
    if (k <= 0) return [];
    if (k === 1) return arr.map((v) => [v]);
    // k >= 2
    return arr.slice(0, arr.length - k + 1).flatMap((v, i) => {
        const rest = combinations(arr.slice(i + 1), k - 1);
        return rest.map((comb) => [v, ...comb]);
    });
}

(window as any).combinations = combinations;
