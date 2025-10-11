build: configure
	@pio run

configure:
	@pio run -t compiledb
	@cd .. && npm run compiledb

upload: configure
	@pio run -t upload

monitor:
	@sleep 1; pio device monitor

clean:
	@pio run -t clean
	@rm -rf .pio .cache

.PHONY: build configure upload clean
