# Concurrency Conventions

## Responsibility of Lock Acquisition

Methods named with double leading and tailing dashes e.g. `__example_method__()`
expects the corresponding locks to be already acquired by the caller.
