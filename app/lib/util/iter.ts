// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { markRaw } from "vue";
import { Awaitable } from "../types";

import { defer, Deferred } from ".";

export class AsyncChain<T = any, P = undefined> {
    // Value is only valid when next is an AsyncChain node.
    readonly value?: T;
    readonly next: Awaitable<AsyncChain<T, P> | null>;
    protected resolve: (value: AsyncChain<T, P> | null) => void;

    constructor(public readonly task: P = undefined as unknown as P) {
        const { promise, resolve } = defer<AsyncChain<T, P> | null>();
        this.next = promise;
        this.resolve = resolve;
        markRaw(this);
    }

    private static async *iterAsync<T, P>(node: AsyncChain<T, P>) {
        while (true) {
            if (node.type === "PENDING") await node.next;
            if (node.type === "END") break;
            yield node.value!;
            node = node.next as AsyncChain<T, P>;
        }
    }

    [Symbol.asyncIterator]() {
        // AsyncChain relies on JavaScript GC Engine to reclaim resources.
        // However, class method holds reference to a node via `this`, the
        // extra closure is therefore used to avoid memory leak.
        return AsyncChain.iterAsync<T, P>(this);
    }

    private static *iterSync<T, P>(node: AsyncChain<T, P>) {
        while (true) {
            switch (node.type) {
                case "PENDING":
                    yield null;
                case "DATA":
                    yield node.value!;
                    node = node.next as AsyncChain<T, P>;
                case "END":
                default:
                    return;
            }
        }
    }

    *[Symbol.iterator]() {
        // AsyncChain relies on JavaScript GC Engine to reclaim resources.
        // However, class method holds reference to a node via `this`, the
        // extra closure is therefore used to avoid memory leak.
        return AsyncChain.iterSync<T, P>(this);
    }

    private get type() {
        if (this.next instanceof Promise) return "PENDING";
        return this.next === null ? "END" : "DATA";
    }


    /**
     * Iterate through values already pushed to the chain (from current node).
     */
    *current_values() {
        let node: AsyncChain<T, P> = this;
        while (node.type === "DATA") {
            yield node.value!;
            node = node.next as AsyncChain<T, P>;
        }
    }

    /**
     * Get length of values already pushed to the chain (from current node).
     */
    get current_length(): number {
        let count = 0;
        for (const _ of this.current_values()) count++;
        return count;
    }

    /**
     * Get the end node ("back") of the current chain.
     * Usage: `chain = chain.back`
     */
    get back(): AsyncChain<T, P> {
        let node: AsyncChain<T, P> = this;
        while (node.type === "DATA")
            node = node.next as AsyncChain<T, P>;
        return node;
    }

    /**
     * Push a new value to the end of the chain.
     * @param value The value to push.
     * @returns The new back node of the chain after pushing the value.
     */
    push(value: T) {
        const { back } = this;
        (back.value as T) = value;
        const next = new AsyncChain<T, P>(this.task);
        (back.next as AsyncChain<T, P>) = next;
        back.resolve(next);
        return next;
    }

    /**
     * Close the chain, block further pushes and deplete async loops.
     */
    close() {
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

export class Zip<T> {
    private readonly items: Iterable<T>[];
    constructor(...items: Iterable<T>[]) {
        this.items = items;
    }

    *[Symbol.iterator]() {
        const iterators = this.items.map((it) => it[Symbol.iterator]());
        try {
            while (true) {
                const values = iterators.map((it) => it.next());
                if (values.some((v) => v.done)) break;
                yield values.map((v) => v.value) as T[];
            }
        } finally {
            for (const it of iterators) {
                try {
                    it.return?.();
                } catch (e) {
                    console.error("Error during iterator return:", e);
                }
            }
        }
    }
}
