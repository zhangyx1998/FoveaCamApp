import { defer } from "./util";

export type Abortable<T> = Promise<T> & { abort: () => Promise<T> };

export default function abortable<T>(
    fn: (aborted: () => boolean) => Promise<T>
) {
    const deferred = defer<T>();
    let aborted = false;
    fn(() => aborted)
        .then(deferred.resolve)
        .catch(deferred.reject);
    return Object.assign(deferred.promise, {
        abort() {
            aborted = true;
            return deferred.promise;
        },
    });
}
