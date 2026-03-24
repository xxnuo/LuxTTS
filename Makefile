PORT ?= 8000
UI_DIR = ui

.PHONY: dev server ui build install

dev:
	@trap 'kill 0' EXIT; \
	$(MAKE) server & \
	$(MAKE) ui & \
	wait

server:
	uv run uvicorn server:app --host 0.0.0.0 --port $(PORT)

ui:
	cd $(UI_DIR) && pnpm dev

build:
	cd $(UI_DIR) && pnpm build

install:
	uv sync
	cd $(UI_DIR) && pnpm install
