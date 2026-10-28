.PHONY: help dev build test test-go test-web e2e inventory lint release clean-cache

VERSION ?= 1.0.0
WAILS   ?= $(shell go env GOPATH)/bin/wails

help:
	@echo "make dev        run the app in development mode (hot reload)"
	@echo "make build      build the desktop app into build/bin"
	@echo "make test       run Go + frontend tests"
	@echo "make e2e        run the Playwright walkthrough (real backend) and refresh docs/screenshots"
	@echo "make inventory  regenerate docs/TestInventory.md"
	@echo "make release    test, build and print checksums"

dev:
	$(WAILS) dev

build:
	$(WAILS) build -ldflags "-X vvterm/app.Version=$(VERSION)"

test: test-go test-web

test-go:
	go vet ./...
	go test -race -count=1 -cover ./...

test-web:
	cd frontend && npm ci && npx tsc --noEmit && npx vitest run

e2e:
	./e2e/run.sh

inventory:
	./scripts/test-inventory.sh

release: test build
	@shasum -a 256 build/bin/vvterm.app/Contents/MacOS/vvterm
