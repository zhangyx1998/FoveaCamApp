build: configure
	@cd build && cmake .. && make -j

configure:
	@mkdir -p build
	@cd build && cmake ..
	@cd .. && npm run compiledb


clean:
	@rm -rf .cache

.PHONY: build configure clean
