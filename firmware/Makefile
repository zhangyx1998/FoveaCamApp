build: configure
	@pio run

# PlatformIO COPIES file://../lib into .pio/libdeps at install time and never
# re-syncs it — a stale copy compiles against outdated protocol headers, or
# worse, silently flashes mismatched wire structs when a layout change still
# compiles. Purge the cache whenever any source under ../lib is newer.
libdeps-sync:
	@stamp=.pio/libdeps/teensy40/integrity.dat; \
	if [ -d .pio/libdeps ]; then \
		if [ ! -f $$stamp ] || [ -n "$$(find ../lib -type f -newer $$stamp -print -quit)" ]; then \
			echo "shared ../lib changed — purging stale .pio/libdeps"; \
			rm -rf .pio/libdeps; \
		fi; \
	fi

configure: libdeps-sync
	@pio run -t compiledb
	@cd .. && npm run compiledb

upload: configure
	@pio run -t upload

monitor:
	@sleep 1; pio device monitor

clean:
	@pio run -t clean
	@rm -rf .pio .cache

.PHONY: build configure upload clean libdeps-sync
