// Inlined rather than imported from `./util/index.js` — that module pulls in
// `vue` (several of its other exports use `ref`/`computed`), which broke the
// orchestrator's Vue-free bundle when `@lib/pid` imported `clamp` from the
// same file (see `lib/pid.ts`'s comment). This file has no *current*
// orchestrator-side consumer, but it's the natural place for a session's
// stream-consumption loop to reach for, so fixing it now avoids the same
// bug recurring the next time something does.
function defer<T = any>() {
  type Resolve = (value: T) => void;
  type Reject = (reason?: any) => void;
  let resolve: Resolve, reject: Reject;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve: resolve!, reject: reject! };
}

export type Abortable<T> = Promise<T> & { abort: () => Promise<T> };

type AbortListener = () => any;

export default function abortable<T>(
    fn: (
        aborted: () => boolean,
        onAbort: (listener: AbortListener) => void
    ) => Promise<T>,
    auto_start: boolean = true
) {
    const deferred = defer<T>();
    let started = false,
        aborted = false,
        finished = false;
    deferred.promise.finally(() => (finished = true));
    const abortListeners: AbortListener[] = [];
    const run = () => {
        if (started) return;
        started = true;
        fn(
            () => aborted,
            (l: AbortListener) => abortListeners.push(l)
        )
            .then(deferred.resolve)
            .catch(deferred.reject);
    };
    if (auto_start) run();
    return Object.assign(deferred.promise, {
        abort() {
            if (!started) {
                started = true;
                deferred.reject(new Error("Aborted before start"));
            }
            aborted = true;
            for (const l of abortListeners) l();
            return deferred.promise;
        },
        start() {
            if (started) return;
        },
        started() {
            return started;
        },
        aborted() {
            return aborted;
        },
        finished() {
            return finished;
        },
    });
}
