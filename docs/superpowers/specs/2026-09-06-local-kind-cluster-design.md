# Local Kubernetes cluster via CDKTF (kind)

Date: 2026-09-06

## Goal
Define a local Kubernetes cluster as code, in TypeScript, using CDK for Terraform
and the `tehcyx/kind` provider. This is the first step of the repo's roadmap; the
same project layout will later host an EKS stack.

## Scope
- `infra/local-kind/`: CDKTF TypeScript app with one stack, `KindClusterStack`.
- Cluster name `devops-local`, one control-plane node and two worker nodes.
- Host ports 80 and 443 mapped to the control-plane node so an ingress
  controller can be added later without recreating the cluster.
- Kubeconfig written to the default location so `kubectl` works immediately.
- No add-ons. Ingress NGINX, metrics server, local registry and a sample app are
  recorded in `docs/TODO.md`.
- `Makefile` targets: `local-install`, `local-test`, `local-up`, `local-down`.
- `docs/local-cluster.md` documents install, deploy, verify and destroy.

## Testing
- Jest tests run `Testing.synth` on the stack and assert the kind cluster
  resource exists with the expected name and node roles.
- Manual verification: `cdktf deploy`, `kubectl get nodes` shows 3 Ready nodes,
  then `cdktf destroy`.

## Out of scope
Any cloud resources, CI/CD pipelines, and add-on installation.
