/* ---------------------------------------------------------
 * Copyright (c) 2026 Yuxuan Zhang, web-dev@z-yx.cc
 * This source code is licensed under the MIT license.
 * You may find the full license in project root directory.
 * ------------------------------------------------------ */

function defer<T>(): {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: any) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: any) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class AbortedError extends Error {
  constructor(reason?: string) {
    let message = "Operation Aborted";
    if (reason) message += `: ${reason}`;
    super(message);
  }
}

class TimeoutError extends AbortedError {
  constructor() {
    super("Operation Timed Out");
  }
}

const additional_context = { AbortedError, TimeoutError };

type AbortableTask<T> =
  // When passed a Promise, it is treated as a non-abortable operation
  // Aborting will only reject the wrapper promise.
  | Promise<T>
  // A cooperative abortable task that follows the Abortable convention
  | ((abortable: AbortContext) => Promise<T>);

// Abort context is a callable handle passed to abortable functions
// When called as a function, it creates a child abortable promise
// When accessed as an object, it provides cooperative cancellation features
type AbortContext = (<T>(task: AbortableTask<T>) => AbortablePromise<T>) &
  // Cooperative cancellation signal
  {
    readonly aborted: boolean;
    // Register a hook to be called upon abort.
    // This helps to break infinite waits/loops, etc.
    onAbort(callback: () => any): AbortContext;
    // Helps to break out of an infinite iteration
    iter<T, R, N, P extends Iterable<T, R, N> | AsyncIterable<T, R, N>>(
      iterable: P,
    ): P;
    // Helps to break out of an infinite async iteration
    iter<T, R, N>(iterable: AsyncIterable<T, R, N>): AsyncIterable<T, R, N>;
  } & typeof additional_context;

type ParentAbortContext = AbortContext & {
  register(ap: AbortablePromise): void;
};

type SettleState = false | "resolved" | "rejected" | "aborted";

export interface AbortablePromise<T = any> extends Promise<T> {
  readonly settled: SettleState;
  /**
   * @param force
   * Reject current promise without waiting for aborted error to propagate
   * through the async call stack, or wait for cooperative cancellation to
   * finish.
   * @returns {void}
   */
  abort: (force?: boolean, err?: any) => Promise<void> | void;
  /**
   * @param ms Timeout in milliseconds to abort the task
   * @param force Whether to forcefully abort the task
   * @returns {AbortablePromise<T>}
   */
  timeout: (ms: number, force?: boolean) => AbortablePromise<T>;
}

function _abortable<T>(task: AbortableTask<T>, parent?: ParentAbortContext) {
  // Fast path: check if parent task has already been aborted
  if (parent?.aborted) throw new AbortedError();
  const { promise, resolve, reject } = defer<T>();
  let settled: SettleState = false;
  const settled_promise = promise.then(
    () => {
      settled = "resolved";
    },
    (e) => {
      settled = e instanceof AbortedError ? "aborted" : "rejected";
    },
  );
  if (task instanceof Promise) {
    // User passed a Promise directly
    // We have no control over the underlying operation,
    // so we can only reject our own promise (forceful) when aborting.
    const ap = Object.assign(promise, {
      get settled() {
        return settled;
      },
      abort(_?: boolean, err = new AbortedError()) {
        if (settled) return;
        reject(err);
        return settled_promise;
      },
    }) as AbortablePromise<T>;
    parent?.register(ap);
    task.then(resolve, reject);
    return ap;
  } else {
    // User passed an abortable function.
    // Assuming cooperative cancellation.
    let abort_triggered = false;
    const pending = new Set<AbortablePromise<any>>();
    const hooks = new Set<() => any>();
    const context: ParentAbortContext = Object.assign(
      // Child abortable context - registers with parent context
      <T>(task: AbortableTask<T>) => _abortable(task, context),
      {
        get aborted() {
          return abort_triggered;
        },
        onAbort(hook: () => any) {
          hooks.add(hook);
          return context;
        },
        iter<T, R, N, P extends Iterable<T, R, N> | AsyncIterable<T, R, N>>(
          iterable: P,
        ): P {
          function iterator(): Iterator<T, R, N> {
            const it = (iterable as Iterable<T, R, N>)[Symbol.iterator]();
            const abortable_it: Iterator<T, R, N> = {
              next(...value) {
                if (abort_triggered)
                  throw new AbortedError("Iteration aborted");
                return it.next(...value);
              },
            };
            if (it.return)
              abortable_it.return = (...args) => it.return!(...args);
            if (it.throw) abortable_it.throw = (...args) => it.throw!(...args);
            return abortable_it;
          }
          function async_iterator(): AsyncIterator<T, R, N> {
            const it = (iterable as AsyncIterable<T, R, N>)[
              Symbol.asyncIterator
            ]();
            const abortable_it: AsyncIterator<T, R, N> = {
              next(...value) {
                const next = it.next(...value);
                return context(next);
              },
            };
            if (it.return)
              abortable_it.return = (...value) => {
                const ret = it.return!(...value);
                return context(ret);
              };
            if (it.throw)
              abortable_it.throw = (...value) => {
                const thr = it.throw!(...value);
                return context(thr);
              };
            return abortable_it;
          }
          return new Proxy(iterable, {
            get(target, prop, receiver) {
              switch (prop) {
                case Symbol.iterator:
                  return iterator;
                case Symbol.asyncIterator:
                  return async_iterator;
                default:
                  return Reflect.get(target, prop, receiver);
              }
            },
          });
        },
        // Parent abort context
        register(ap: AbortablePromise) {
          pending.add(ap);
          const cleanup = () => pending.delete(ap);
          ap.then(cleanup, cleanup);
        },
        ...additional_context
      },
    );
    const ap: AbortablePromise<T> = Object.assign(promise, {
      get settled() {
        return settled;
      },
      abort: (force = false, err = new AbortedError()) => {
        if (settled) return;
        abort_triggered = true;
        const hooks_called = [...hooks].map((f) => f());
        const pending_aborted = [...pending].map((p) => p.abort(force));
        return force
          ? reject(err)
          : Promise.all([
              ...hooks_called,
              ...pending_aborted,
              settled_promise,
            ]).then(() => {});
      },
      timeout(ms: number, force = false) {
        if (settled) return ap;
        const tid = setTimeout(() => ap.abort(force, new TimeoutError()), ms);
        // Clear timeout if settled earlier
        settled_promise.then(() => clearTimeout(tid));
        return ap;
      },
    });
    parent?.register(ap);
    task(context).then(resolve, reject);
    return ap;
  }
}

function abortable<T>(target: AbortableTask<T>) {
  return _abortable(target);
}

export default Object.assign(abortable, additional_context);
