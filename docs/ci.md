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

## Functions

| Function    | What it does                                                        |
|-------------|---------------------------------------------------------------------|
| `base`      | Builds the container all other steps share: Node 22, pnpm (pinned via `packageManager`), the Terraform CLI copied from the `hashicorp/terraform` image, `pnpm install --frozen-lockfile`, `cdktf get`. |
| `typecheck` | `tsc --noEmit` on `infra/local-kind`.                               |
| `test`      | `pnpm test` (jest).                                                 |
| `synth`     | `cdktf synth`; returns the `cdktf.out` directory.                   |
| `ci`        | Runs the three checks concurrently and reports every failing step.  |

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
