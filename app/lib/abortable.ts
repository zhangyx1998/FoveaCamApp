import { defer } from "./util/index.js";

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
