/**
 * CI pipeline for the devops repo.
 *
 * Every function here runs the same way on a laptop (`make ci`) and in
 * GitHub Actions (`dagger call ci`). The pipeline typechecks, unit-tests and
 * synthesizes the CDKTF stack in `infra/local-kind`; it never deploys.
 */
import {
  dag,
  Container,
  Directory,
  argument,
  func,
  object,
} from "@dagger.io/dagger"

const NODE_IMAGE = "node:22-bookworm-slim"
const TERRAFORM_IMAGE = "hashicorp/terraform:1.13"
const STACK_DIR = "infra/local-kind"
const WORKDIR = "/work"

/** Paths under the repo root that must never enter the build context. */
const IGNORE = [
  "**/node_modules",
  "**/.gen",
  "**/cdktf.out",
  "**/*.tfstate",
  "**/*.tfstate.*",
  "**/.terraform",
  ".git",
  "ci",
]

@object()
export class Devops {
  /**
   * Node + pnpm + Terraform container with dependencies installed and CDKTF
   * provider bindings generated for the local-kind stack.
   */
  @func()
  base(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Container {
    const terraform = dag
      .container()
      .from(TERRAFORM_IMAGE)
      .file("/bin/terraform")

    const stack = source.directory(STACK_DIR)

    return dag
      .container()
      .from(NODE_IMAGE)
      .withExec([
        "sh",
        "-c",
        "apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*",
      ])
      .withFile("/usr/local/bin/terraform", terraform)
      .withExec(["corepack", "enable", "pnpm"])
      .withEnvVariable("CI", "true")
      .withEnvVariable("CHECKPOINT_DISABLE", "1")
      .withMountedCache(
        "/root/.local/share/pnpm/store",
        dag.cacheVolume("devops-pnpm-store"),
      )
      .withWorkdir(WORKDIR)
      .withDirectory(WORKDIR, stack)
      .withExec(["pnpm", "install", "--frozen-lockfile"])
      .withMountedCache(
        `${WORKDIR}/.gen`,
        dag.cacheVolume("devops-cdktf-gen"),
      )
      .withExec(["pnpm", "exec", "cdktf", "get"])
  }

  /** Type-check the stack with the TypeScript compiler. */
  @func()
  async typecheck(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    return this.base(source)
      .withExec(["pnpm", "exec", "tsc", "--noEmit"])
      .stdout()
  }

  /** Run the jest unit tests. */
  @func()
  async test(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    return this.base(source).withExec(["pnpm", "test"]).stdout()
  }

  /** Synthesize the Terraform configuration and return `cdktf.out`. */
  @func()
  synth(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Directory {
    return this.base(source)
      .withExec(["pnpm", "exec", "cdktf", "synth"])
      .directory(`${WORKDIR}/cdktf.out`)
  }

  /**
   * Run typecheck, test and synth concurrently. Fails if any step fails.
   *
   * Strategy: run everything and surface every failure, rather than stopping at
   * the first one, so a single CI run shows the full picture.
   */
  @func()
  async ci(
    @argument({ defaultPath: "/", ignore: IGNORE }) source: Directory,
  ): Promise<string> {
    const steps: Record<string, Promise<unknown>> = {
      typecheck: this.typecheck(source),
      test: this.test(source),
      synth: this.synth(source).sync(),
    }

    const results = await Promise.allSettled(Object.values(steps))
    const names = Object.keys(steps)
    const failed = results
      .map((r, i) => (r.status === "rejected" ? names[i] : null))
      .filter((n): n is string => n !== null)

    if (failed.length > 0) {
      throw new Error(`CI failed: ${failed.join(", ")}`)
    }
    return `CI passed: ${names.join(", ")}`
  }
}
