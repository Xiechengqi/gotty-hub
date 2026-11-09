.PHONY: build test web dev check
build: web
	cargo build --locked --release
web:
	cd frontend && npm ci && npm run build
check:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	test -f frontend/vendor/gotty-terminal-core-0.1.0.tgz
test:
	cargo build --locked
	cargo test --locked
	python3 tests/config.py
	cd frontend && npm run test:ui
	python3 tests/run-integration.py
dev:
	HUB_DEV=1 HUB_ORIGIN=http://localhost:5178 cargo run
