.PHONY: package help dev build test test-go test-web e2e inventory lint release clean-cache deploy-dev deploy-prod

VERSION ?= $(shell cat VERSION)
WAILS   ?= $(shell go env GOPATH)/bin/wails

help:
	@echo "make dev        run the app in development mode (hot reload)"
	@echo "make build      build the desktop app into build/bin"
	@echo "make test       run Go + frontend tests"
	@echo "make e2e        run the Playwright walkthrough (real backend) and refresh docs/screenshots"
	@echo "make inventory  regenerate docs/TestInventory.md"
	@echo "make package    build and create dist/*.dmg and *.zip (macOS)"
	@echo "make release    test, build and print checksums"

dev:
	$(WAILS) dev

build:
	$(WAILS) build -ldflags "-X vvterm/app.Version=$(VERSION)"
	@if [ "$$(uname)" = Darwin ]; then ./scripts/macos-settings-helper.sh build/bin/vvterm.app; fi
	@if [ "$$(uname)" = Darwin ]; then codesign --force --deep --sign - build/bin/vvterm.app; fi

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

package:
	./scripts/package-macos.sh --build

release: test build
	@shasum -a 256 build/bin/vvterm.app/Contents/MacOS/vvterm

deploy-dev:
	./scripts/deploy.sh dev

deploy-prod:
	./scripts/deploy.sh prod
