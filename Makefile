# Local Kubernetes cluster (kind) defined with CDK for Terraform.
# Run `make help` for a list of targets.

KIND_DIR := infra/local-kind
KUBECONFIG_LOCAL := $(KIND_DIR)/cdktf.out/stacks/local-kind/devops-local-config

.PHONY: help local-install local-test local-synth local-up local-down local-status

help: ## Show this help
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | awk 'BEGIN {FS = ":.*?## "}; {printf "  \033[36m%-16s\033[0m %s\n", $$1, $$2}'

local-install: ## Install npm dependencies and generate provider bindings
	cd $(KIND_DIR) && pnpm install && pnpm exec cdktf get

local-test: ## Run Jest tests against the synthesized Terraform
	cd $(KIND_DIR) && pnpm test

local-synth: ## Synthesize Terraform JSON into cdktf.out/
	cd $(KIND_DIR) && pnpm exec cdktf synth

local-up: ## Create the local kind cluster
	cd $(KIND_DIR) && pnpm exec cdktf deploy --auto-approve

local-down: ## Destroy the local kind cluster
	cd $(KIND_DIR) && pnpm exec cdktf destroy --auto-approve

local-status: ## Show cluster nodes
	kubectl --kubeconfig $(KUBECONFIG_LOCAL) get nodes -o wide
