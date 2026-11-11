.PHONY: build test web dev check
build: web
	cargo build --locked --release
web:
	cd frontend && npm ci && npm run build
check:
	cargo fmt --all -- --check
	cargo clippy --all-targets -- -D warnings
	python3 scripts/check-core.py
test:
	cargo build --locked
	cargo test --locked
	python3 tests/config.py
	cd frontend && npm test
	python3 tests/run-integration.py
dev:
	cargo run
