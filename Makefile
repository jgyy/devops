KIND_DIR := infra/local-kind
KUBECONFIG_LOCAL := $(KIND_DIR)/cdktf.out/stacks/local-kind/devops-local-config

AWS_DIR := infra/aws-kind
AWS_REGION ?= ap-southeast-1
KUBECONFIG_AWS := $(AWS_DIR)/kubeconfig
DASH_DIR := infra/dashboard
STATE_BUCKET ?= devops-tfstate-$(shell aws sts get-caller-identity --query Account --output text 2>/dev/null)
AWS_INSTANCE_ID = $(shell aws ec2 describe-instances --region $(AWS_REGION) \
	--filters Name=tag:Name,Values=devops-aws-host Name=instance-state-name,Values=pending,running,stopping,stopped \
	--query 'Reservations[0].Instances[0].InstanceId' --output text)

export NODE_OPTIONS := --no-experimental-webstorage --max-old-space-size=4096

.DEFAULT_GOAL := help
.PHONY: help local-install local-test local-synth local-up local-down local-status \
	aws-install aws-test aws-synth aws-bootstrap aws-up aws-down aws-start aws-stop \
	aws-tunnel aws-kubeconfig aws-status \
	dashboard-install dashboard-test dashboard-synth \
	dashboard-local-up dashboard-local-down dashboard-aws-up dashboard-aws-down dashboard-open \
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

aws-install: ## Install deps and fetch CDKTF providers for the AWS stack
	cd $(AWS_DIR) && pnpm install && pnpm exec cdktf get

aws-test: ## Run the AWS stack unit tests
	cd $(AWS_DIR) && pnpm test

aws-synth: ## Synthesize Terraform config for the AWS stacks
	cd $(AWS_DIR) && STATE_BUCKET=$(STATE_BUCKET) pnpm exec cdktf synth

aws-bootstrap: ## Create the S3 state bucket (once per account)
	cd $(AWS_DIR) && STATE_BUCKET=$(STATE_BUCKET) pnpm exec cdktf deploy aws-bootstrap --auto-approve

aws-up: ## Create the EC2 host; it boots a kind cluster and stops itself after LIFETIME_MINUTES (default 60)
	cd $(AWS_DIR) && STATE_BUCKET=$(STATE_BUCKET) pnpm exec cdktf deploy aws-kind --auto-approve \
		$(if $(LIFETIME_MINUTES),--var lifetime_minutes=$(LIFETIME_MINUTES),)

aws-down: ## Destroy the EC2 host and its network (keeps the state bucket)
	cd $(AWS_DIR) && STATE_BUCKET=$(STATE_BUCKET) pnpm exec cdktf destroy aws-kind --auto-approve

aws-start: ## Start a stopped host; the kind cluster and the auto-stop timer are recreated on boot
	aws ec2 start-instances --region $(AWS_REGION) --instance-ids $(AWS_INSTANCE_ID)

aws-stop: ## Stop the host now instead of waiting for the timer
	aws ec2 stop-instances --region $(AWS_REGION) --instance-ids $(AWS_INSTANCE_ID)

aws-tunnel: ## Forward localhost:6443 to the cluster API through SSM (keep running in its own terminal)
	aws ssm start-session --region $(AWS_REGION) --target $(AWS_INSTANCE_ID) \
		--document-name AWS-StartPortForwardingSession \
		--parameters '{"portNumber":["6443"],"localPortNumber":["6443"]}'

aws-kubeconfig: ## Fetch the cluster kubeconfig via SSM into infra/aws-kind/kubeconfig
	@cmd=$$(aws ssm send-command --region $(AWS_REGION) --instance-ids $(AWS_INSTANCE_ID) \
		--document-name AWS-RunShellScript --parameters 'commands=["cat /etc/kind/kubeconfig"]' \
		--query Command.CommandId --output text) && \
	aws ssm wait command-executed --region $(AWS_REGION) --command-id $$cmd --instance-id $(AWS_INSTANCE_ID) && \
	aws ssm get-command-invocation --region $(AWS_REGION) --command-id $$cmd --instance-id $(AWS_INSTANCE_ID) \
		--query StandardOutputContent --output text > $(KUBECONFIG_AWS) && \
	echo "wrote $(KUBECONFIG_AWS)"

aws-status: ## Show nodes of the AWS kind cluster (needs aws-tunnel running)
	kubectl --kubeconfig $(KUBECONFIG_AWS) get nodes -o wide

dashboard-install: ## Install deps and fetch CDKTF providers for the dashboard stack
	cd $(DASH_DIR) && pnpm install && pnpm exec cdktf get

dashboard-test: ## Run the dashboard stack unit tests
	cd $(DASH_DIR) && pnpm test

dashboard-synth: ## Synthesize Terraform config for both dashboard stacks
	cd $(DASH_DIR) && pnpm exec cdktf synth

dashboard-local-up: ## Install the dashboard on the local cluster (uses your AWS CLI credentials)
	@eval "$$(aws configure export-credentials --format env)" && cd $(DASH_DIR) && \
	TF_VAR_aws_access_key_id="$$AWS_ACCESS_KEY_ID" \
	TF_VAR_aws_secret_access_key="$$AWS_SECRET_ACCESS_KEY" \
	TF_VAR_aws_session_token="$${AWS_SESSION_TOKEN:-}" \
	pnpm exec cdktf deploy dashboard-local --auto-approve

dashboard-local-down: ## Remove the dashboard from the local cluster
	cd $(DASH_DIR) && \
	TF_VAR_aws_access_key_id=x TF_VAR_aws_secret_access_key=x \
	pnpm exec cdktf destroy dashboard-local --auto-approve

dashboard-aws-up: ## Install the dashboard on the AWS cluster (needs aws-tunnel running; uses the instance role)
	cd $(DASH_DIR) && pnpm exec cdktf deploy dashboard-aws --auto-approve

dashboard-aws-down: ## Remove the dashboard from the AWS cluster (needs aws-tunnel running)
	cd $(DASH_DIR) && pnpm exec cdktf destroy dashboard-aws --auto-approve

TARGET ?= local
DASH_KUBECONFIG = $(if $(filter aws,$(TARGET)),$(KUBECONFIG_AWS),$(KUBECONFIG_LOCAL))
dashboard-open: ## Port-forward Grafana to http://localhost:3000 (TARGET=local|aws, login admin/admin)
	@echo "Grafana: http://localhost:3000  (admin / admin)"
	kubectl --kubeconfig $(DASH_KUBECONFIG) -n dashboard port-forward svc/kube-prometheus-stack-grafana 3000:80

CI_DIR := ci
export DAGGER_NO_NAG := 1
STACK ?= infra/local-kind

ci: ## Run the full CI pipeline (typecheck, test, synth) for all stacks via Dagger
	dagger -m $(CI_DIR) call ci

ci-typecheck: ## Type-check one stack via Dagger (STACK=infra/aws-kind to pick another)
	dagger -m $(CI_DIR) call typecheck --stack-dir $(STACK)

ci-test: ## Run one stack's unit tests via Dagger (STACK=...)
	dagger -m $(CI_DIR) call test --stack-dir $(STACK)

ci-synth: ## Synthesize one stack via Dagger and export cdktf.out to ./ci/out (STACK=...)
	dagger -m $(CI_DIR) call synth --stack-dir $(STACK) export --path $(CI_DIR)/out
