# CI pipeline

The pipeline is a [Dagger](https://dagger.io) module written in TypeScript
under `ci/`. GitHub Actions and the Makefile both call the same functions, so
what runs on a pull request is exactly what runs on your laptop.

```mermaid
flowchart LR
    make["make ci"] --> call["dagger call ci"]
    gha[".github/workflows/ci.yml<br/>push to main, pull_request"] --> call
    call --> base["base<br/>node:22 + pnpm + terraform<br/>pnpm install, cdktf get"]
    base --> typecheck["typecheck<br/>tsc --noEmit"]
    base --> test["test<br/>jest"]
    base --> synth["synth<br/>cdktf synth"]
    typecheck & test & synth --> result{"all passed?"}
    result -->|yes| ok["CI passed"]
    result -->|no| fail["CI failed: list of steps"]
```

`ci` runs typecheck, test and synth for all three CDKTF stacks —
`infra/local-kind`, `infra/aws-kind` and `infra/dashboard` — concurrently,
one `base` container per stack.

## Functions

| Function    | What it does                                                        |
|-------------|---------------------------------------------------------------------|
| `base`      | Builds the container all other steps share for a given stack (`stackDir`, default `infra/local-kind`): Node 22, pnpm (pinned via `packageManager`), the Terraform CLI copied from the `hashicorp/terraform` image, `pnpm install --frozen-lockfile`, `cdktf get`. Sets `STATE_BUCKET=ci` so `infra/aws-kind` can synth. |
| `typecheck` | `tsc --noEmit` on the given `stackDir`.                             |
| `test`      | `pnpm test` (jest) on the given `stackDir`.                         |
| `synth`     | `cdktf synth` on the given `stackDir`; returns the `cdktf.out` directory. |
| `ci`        | Runs typecheck, test and synth for `infra/local-kind`, `infra/aws-kind` and `infra/dashboard` concurrently (nine steps) and reports every failing one. |

The single-step targets and functions take a stack directory: `dagger -m ci
call typecheck --stack-dir infra/aws-kind`, or `make ci-typecheck
STACK=infra/aws-kind` (defaults to `infra/local-kind`).

The pnpm store and the generated `.gen/` provider bindings live in Dagger
cache volumes, so repeat runs skip the install and provider download.

## Running locally

Requires the `dagger` CLI and a running Docker daemon.

```sh
make ci             # everything
make ci-test        # just jest
make ci-typecheck   # just tsc
make ci-synth       # synth and export cdktf.out to ci/out/
dagger -m ci functions   # list functions with descriptions
```

## GitHub Actions

`.github/workflows/ci.yml` checks out the repo, installs the pinned Dagger CLI
with `dagger/dagger-for-github`, and runs `dagger call ci` from the `ci`
module. No secrets are required. Superseded runs on the same ref are cancelled.

## Deliberately out of scope

CI never runs `cdktf deploy`. Creating and destroying the kind cluster stays a
local `make local-up` / `make local-down` operation.
