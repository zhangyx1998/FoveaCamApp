build: configure
	@node scripts/make.cjs build

configure:
	@node scripts/make.cjs configure

clean:
	@node scripts/make.cjs clean
	@rm -rf .cache

app: build
	@cd .. && npx electron app

.PHONY: all configure clean app
