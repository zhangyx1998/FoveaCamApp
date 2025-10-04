// ------------------------------------------------------
// Copyright (c) 2025 Yuxuan Zhang, dev@z-yx.cc
// This source code is licensed under the MIT license.
// You may find the full license in project root directory.
// -------------------------------------------------------
import { markRaw } from "vue";
import { Awaitable } from "../types";

import { defer } from ".";

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
