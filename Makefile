# galdor — common tasks. Run `make` (or `make help`) to list targets.
#
# Overridable variables:
#   BUN=bun           the bun executable
#   DB=./traces.db    span store the scry/ui targets read from
#   PORT=7777         dashboard port
#   RUN=demo-run-1    run id for `make scry-show`

BUN  ?= bun
DB   ?= ./traces.db
PORT ?= 7777
RUN  ?= demo-run-1
CLI   = $(BUN) packages/cli/src/main.ts

.DEFAULT_GOAL := help

.PHONY: help install build test pack binary seed scry scry-show weave ui clean

help: ## List available targets
	@grep -hE '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) \
		| awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-12s\033[0m %s\n", $$1, $$2}'

install: ## Install dependencies (bun install)
	$(BUN) install

build: ## Build every package into dist/
	$(BUN) run build

test: ## Run the test suite
	$(BUN) test

pack: ## Build + write installable tarballs to dist-tarballs/
	$(BUN) run pack

binary: ## Compile the single `galdor` binary into ./galdor
	cd packages/cli && $(BUN) build --compile --target=bun ./src/main.ts --outfile ../../galdor
	@echo "→ ./galdor"

# $(DB) is a real file target: scry/ui depend on it, so the store is seeded
# automatically the first time. Delete it (make clean) to regenerate.
$(DB):
	$(BUN) scripts/seed-traces.ts $(DB)

seed: $(DB) ## Write demo runs into $(DB) (only if missing)

scry: $(DB) ## List recorded runs from $(DB)
	$(CLI) scry list --db $(DB)

scry-show: $(DB) ## Show a run's span tree:  make scry-show RUN=demo-run-1
	$(CLI) scry show $(RUN) --db $(DB)

weave: $(DB) ## Print the graph topology for RUN
	$(CLI) weave $(RUN) --db $(DB)

ui: $(DB) ## Launch the observability dashboard on $(DB) (http://127.0.0.1:$(PORT))
	$(CLI) ui --db $(DB) --port $(PORT)

clean: ## Remove build output, tarballs, demo db and binary
	rm -rf $(shell echo packages/*/dist) dist-tarballs galdor $(DB) $(DB)-wal $(DB)-shm
