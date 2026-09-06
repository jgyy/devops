import "cdktf/lib/testing/adapters/jest";
import { execFileSync } from "node:child_process";
import { Testing } from "cdktf";
import {
  AwsKindStack,
  BootstrapStack,
  CLUSTER_NAME,
  DASHBOARD_READ_ACTIONS,
  INSTANCE_TYPE,
  REGION,
  userData,
} from "../main";

const BUCKET = "devops-tfstate-123456789012";

function firstResource(parsed: any, type: string): any {
  return Object.values(parsed.resource[type])[0];
}

/**
 * `toBeValidTerraform()` runs a real `terraform init`, which for the aws-kind
 * stack would try to reach the S3 backend. Validate without a backend instead.
 */
function expectValidTerraform(dir: string): void {
  for (const args of [["init", "-backend=false", "-input=false", "-no-color"], ["validate", "-no-color"]]) {
    execFileSync("terraform", args, { cwd: dir, stdio: "pipe" });
  }
}

describe("BootstrapStack", () => {
  const app = Testing.app();
  const stack = new BootstrapStack(app, "bootstrap-test", { bucketName: BUCKET });
  const parsed = JSON.parse(Testing.synth(stack));

  it("creates the state bucket in the configured region", () => {
    expect(firstResource(parsed, "aws_s3_bucket").bucket).toBe(BUCKET);
    expect(Object.values(parsed.provider.aws)[0]).toMatchObject({ region: REGION });
  });

  it("enables versioning so state history can be recovered", () => {
    const versioning = firstResource(parsed, "aws_s3_bucket_versioning");
    expect(versioning.versioning_configuration.status).toBe("Enabled");
  });

  it("blocks all public access", () => {
    expect(firstResource(parsed, "aws_s3_bucket_public_access_block")).toMatchObject({
      block_public_acls: true,
      block_public_policy: true,
      ignore_public_acls: true,
      restrict_public_buckets: true,
    });
  });

  it("produces valid Terraform", () => {
    expect(Testing.fullSynth(stack)).toBeValidTerraform();
  });
});

describe("AwsKindStack", () => {
  const app = Testing.app();
  const stack = new AwsKindStack(app, "aws-kind-test", { stateBucket: BUCKET });
  const parsed = JSON.parse(Testing.synth(stack));
  const instance = firstResource(parsed, "aws_instance");

  it("stores state in the bootstrap bucket with lockfile locking", () => {
    expect(parsed.terraform.backend.s3).toMatchObject({
      bucket: BUCKET,
      region: REGION,
      use_lockfile: true,
    });
  });

  it("launches one instance of the expected type that stops on shutdown", () => {
    expect(Object.keys(parsed.resource.aws_instance)).toHaveLength(1);
    expect(instance.instance_type).toBe(INSTANCE_TYPE);
    expect(instance.instance_initiated_shutdown_behavior).toBe("stop");
  });

  it("requires IMDSv2", () => {
    expect(instance.metadata_options.http_tokens).toBe("required");
  });

  it("replaces the instance when the user data changes", () => {
    expect(instance.user_data_replace_on_change).toBe(true);
  });

  it("only exposes 80 and 443, never SSH or the API server", () => {
    const rules = Object.values(parsed.resource.aws_vpc_security_group_ingress_rule) as any[];
    const ports = rules.map((r) => r.from_port).sort();
    expect(ports).toEqual([443, 80].sort());
    expect(ports).not.toContain(22);
    expect(ports).not.toContain(6443);
  });

  it("grants the instance SSM access instead of SSH", () => {
    const attachments = Object.values(parsed.resource.aws_iam_role_policy_attachment) as any[];
    expect(attachments.map((a) => a.policy_arn)).toContain(
      "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore",
    );
    expect(instance.iam_instance_profile).toBeDefined();
  });

  it("lets pods reach IMDSv2 through the kind node container", () => {
    expect(instance.metadata_options.http_put_response_hop_limit).toBe(3);
  });

  it("grants the dashboard read-only access to EC2, S3 and CloudWatch", () => {
    const policy = firstResource(parsed, "aws_iam_role_policy");
    const doc = JSON.parse(policy.policy);
    expect(doc.Statement).toHaveLength(1);
    expect(doc.Statement[0].Effect).toBe("Allow");
    expect(doc.Statement[0].Action).toEqual(DASHBOARD_READ_ACTIONS);
    for (const action of DASHBOARD_READ_ACTIONS) {
      expect(action).toMatch(/^(ec2:Describe\*|s3:(ListAllMyBuckets|GetBucket\*)|cloudwatch:(GetMetricData|ListMetrics|GetMetricStatistics)|tag:GetResources|sts:GetCallerIdentity)$/);
    }
  });

  it("exposes the lifetime as a variable that feeds the user data", () => {
    expect(parsed.variable.lifetime_minutes.default).toBe(60);
    expect(instance.user_data).toContain("shutdown -h +${var.lifetime_minutes}");
  });

  it("produces valid Terraform", () => {
    expectValidTerraform(Testing.fullSynth(stack));
  });
});

describe("userData", () => {
  const script = userData("45");
  const lines = script.split("\n");

  it("schedules the stop before installing anything", () => {
    const shutdownAt = lines.findIndex((l) => l.startsWith("shutdown -h +45"));
    const installAt = lines.findIndex((l) => l.includes("dnf install"));
    expect(shutdownAt).toBeGreaterThan(0);
    expect(shutdownAt).toBeLessThan(installAt);
  });

  it("creates a cluster with the same topology as the local one", () => {
    expect(script).toContain(`--name ${CLUSTER_NAME}`);
    expect(script.match(/role: worker/g)).toHaveLength(2);
    expect(script.match(/role: control-plane/g)).toHaveLength(1);
    expect(script).toContain("ingress-ready");
    expect(script).toContain("hostPort: 80");
    expect(script).toContain("hostPort: 443");
  });

  it("pins the API server to 6443 for the SSM tunnel", () => {
    expect(script).toContain("apiServerPort: 6443");
  });

  it("re-runs on every boot through a systemd unit", () => {
    expect(script).toContain("kind-cluster.service");
    expect(script).toContain("WantedBy=multi-user.target");
  });
});
