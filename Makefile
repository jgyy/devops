KIND_DIR := infra/local-kind
KUBECONFIG_LOCAL := $(KIND_DIR)/cdktf.out/stacks/local-kind/devops-local-config

export NODE_OPTIONS := --no-experimental-webstorage --max-old-space-size=4096

.DEFAULT_GOAL := help
.PHONY: help local-install local-test local-synth local-up local-down local-status \
	ci ci-typecheck ci-test ci-synth

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

local-install: ## Install deps and fetch CDKTF providers
	cd $(KIND_DIR) && pnpm install && pnpm exec cdktf get

local-test: ## Run the CDKTF unit tests
	cd $(KIND_DIR) && pnpm test

local-synth: ## Synthesize Terraform config for the kind cluster
	cd $(KIND_DIR) && pnpm exec cdktf synth

local-up: ## Create the local kind cluster
	cd $(KIND_DIR) && pnpm exec cdktf deploy --auto-approve

local-status: ## Show nodes of the local kind cluster
	kubectl --kubeconfig $(KUBECONFIG_LOCAL) get nodes -o wide

local-down: ## Destroy the local kind cluster
	cd $(KIND_DIR) && pnpm exec cdktf destroy --auto-approve

CI_DIR := ci
export DAGGER_NO_NAG := 1

ci: ## Run the full CI pipeline (typecheck, test, synth) via Dagger
	dagger -m $(CI_DIR) call ci

ci-typecheck: ## Type-check the stack via Dagger
	dagger -m $(CI_DIR) call typecheck

ci-test: ## Run the unit tests via Dagger
	dagger -m $(CI_DIR) call test

ci-synth: ## Synthesize the stack via Dagger and export cdktf.out to ./ci/out
	dagger -m $(CI_DIR) call synth export --path $(CI_DIR)/out
