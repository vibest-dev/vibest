.DEFAULT_GOAL := build

.PHONY: setup build vet test package run

VT_SHA256 := 6f385d3221f8c776ba40530db9baf8c71478907897959849896eeb0ddbf16b41
VT_CACHED := $(HOME)/Library/Caches/mygo/natives/$(VT_SHA256)/libghostty-vt.dylib

ifneq ($(shell uname -s),Darwin)
build vet test package run setup:
	@echo "apps/desktop: macOS only, skipped"
else
setup:
	sh scripts/patch-mygo.sh

build vet test package run: | setup

build:
	mkdir -p build
	go build -o build/reherdr ./cmd/reherdr

vet:
	go vet ./...
	@files=$$(gofmt -l cmd internal testdata); [ -z "$$files" ] || { echo "gofmt needed:" $$files >&2; exit 1; }

test:
	python3 scripts/test_patch_mygo.py
	python3 scripts/test_make.py
	@vt="$${MYGO_GHOSTTY_VT:-$(VT_CACHED)}"; \
	[ -f "$$vt" ] && [ "$$(shasum -a 256 "$$vt" | cut -d' ' -f1)" = "$(VT_SHA256)" ] || { \
		echo "apps/desktop: the test suite needs MyGo's libghostty-vt.dylib with SHA256 $(VT_SHA256) at MYGO_GHOSTTY_VT or $(VT_CACHED); see apps/desktop/README.md" >&2; exit 1; }; \
	MYGO_GHOSTTY_VT="$$vt" go test ./...

package:
	go run github.com/egoist/mygo/cmd/mygo build -sign - -skip-notarize -skip-dmg -o out .

run: build
	./build/reherdr $(ARGS)
endif
