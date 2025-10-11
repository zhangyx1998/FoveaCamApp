build: configure
	@node scripts/make.cjs build
	@cd .. && npm run compiledb

configure:
	@node scripts/make.cjs configure
	@cd .. && npm run compiledb

clean:
	@node scripts/make.cjs clean
	@rm -rf .cache

app: build
	@cd .. && npx electron app

.PHONY: all configure clean app
