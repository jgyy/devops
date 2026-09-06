import {
  App,
  S3Backend,
  TerraformOutput,
  TerraformStack,
  TerraformVariable,
} from "cdktf";
import { Construct } from "constructs";
import { AwsProvider } from "./.gen/providers/aws/provider";
import { DataAwsSsmParameter } from "./.gen/providers/aws/data-aws-ssm-parameter";
import { S3Bucket } from "./.gen/providers/aws/s3-bucket";
import { S3BucketVersioningA } from "./.gen/providers/aws/s3-bucket-versioning";
import { S3BucketServerSideEncryptionConfigurationA } from "./.gen/providers/aws/s3-bucket-server-side-encryption-configuration";
import { S3BucketPublicAccessBlock } from "./.gen/providers/aws/s3-bucket-public-access-block";
import { Vpc } from "./.gen/providers/aws/vpc";
import { Subnet } from "./.gen/providers/aws/subnet";
import { InternetGateway } from "./.gen/providers/aws/internet-gateway";
import { RouteTable } from "./.gen/providers/aws/route-table";
import { Route } from "./.gen/providers/aws/route";
import { RouteTableAssociation } from "./.gen/providers/aws/route-table-association";
import { SecurityGroup } from "./.gen/providers/aws/security-group";
import { VpcSecurityGroupIngressRule } from "./.gen/providers/aws/vpc-security-group-ingress-rule";
import { VpcSecurityGroupEgressRule } from "./.gen/providers/aws/vpc-security-group-egress-rule";
import { IamRole } from "./.gen/providers/aws/iam-role";
import { IamRolePolicyAttachment } from "./.gen/providers/aws/iam-role-policy-attachment";
import { IamInstanceProfile } from "./.gen/providers/aws/iam-instance-profile";
import { Instance } from "./.gen/providers/aws/instance";

export const REGION = "ap-southeast-1";
export const CLUSTER_NAME = "devops-aws";
/** 2 vCPU / 8 GB: kind with three nodes needs more than a t3.medium's 4 GB. */
export const INSTANCE_TYPE = "t3a.large";
export const KIND_VERSION = "v0.32.0";

const AL2023_AMI_PARAMETER =
  "/aws/service/ami-amazon-linux-latest/al2023-ami-kernel-default-x86_64";
const SSM_CORE_POLICY = "arn:aws:iam::aws:policy/AmazonSSMManagedInstanceCore";

const TAGS = { Project: "devops", Stack: "aws-kind" };

/**
 * Boot script for the instance.
 *
 * The first thing it does is schedule a stop, so the instance cannot outlive
 * `lifetimeMinutes` even if everything after that line fails. The real work
 * lives in a systemd oneshot unit so it also runs on every later boot: after
 * the auto-stop, `make aws-start` gets a fresh cluster and a fresh timer.
 *
 * `lifetimeMinutes` is spliced in as a Terraform token, so the script must not
 * use bash `${...}` syntax of its own (Terraform would try to interpolate it).
 */
export function userData(lifetimeMinutes: string): string {
  return [
    "#!/bin/bash",
    "set -euo pipefail",
    `shutdown -h +${lifetimeMinutes} "${CLUSTER_NAME} lifetime reached"`,
    "",
    "cat >/usr/local/sbin/kind-cluster.sh <<'EOS'",
    "#!/bin/bash",
    "set -euo pipefail",
    `shutdown -h +${lifetimeMinutes} "${CLUSTER_NAME} lifetime reached"`,
    "",
    "# kind runs several kubelets on one host; raise the inotify limits it needs.",
    "sysctl -w fs.inotify.max_user_watches=524288 fs.inotify.max_user_instances=512",
    "",
    "if ! command -v docker >/dev/null; then dnf install -y docker; fi",
    "systemctl enable --now docker",
    "",
    "if ! command -v kind >/dev/null; then",
    `  curl -fsSLo /usr/local/bin/kind https://kind.sigs.k8s.io/dl/${KIND_VERSION}/kind-linux-amd64`,
    "  chmod +x /usr/local/bin/kind",
    "fi",
    "if ! command -v kubectl >/dev/null; then",
    "  KUBECTL_VERSION=$(curl -fsSL https://dl.k8s.io/release/stable.txt)",
    '  curl -fsSLo /usr/local/bin/kubectl "https://dl.k8s.io/release/$KUBECTL_VERSION/bin/linux/amd64/kubectl"',
    "  chmod +x /usr/local/bin/kubectl",
    "fi",
    "",
    "mkdir -p /etc/kind",
    "cat >/etc/kind/config.yaml <<'EOC'",
    "kind: Cluster",
    "apiVersion: kind.x-k8s.io/v1alpha4",
    "networking:",
    "  apiServerAddress: 127.0.0.1",
    "  apiServerPort: 6443",
    "nodes:",
    "  - role: control-plane",
    "    labels:",
    '      ingress-ready: "true"',
    "    kubeadmConfigPatches:",
    "      - |",
    "        kind: InitConfiguration",
    "        nodeRegistration:",
    "          kubeletExtraArgs:",
    '            node-labels: "ingress-ready=true"',
    "    extraPortMappings:",
    "      - containerPort: 80",
    "        hostPort: 80",
    "        protocol: TCP",
    "      - containerPort: 443",
    "        hostPort: 443",
    "        protocol: TCP",
    "  - role: worker",
    "  - role: worker",
    "EOC",
    "",
    `kind delete cluster --name ${CLUSTER_NAME} || true`,
    `kind create cluster --name ${CLUSTER_NAME} --config /etc/kind/config.yaml --wait 180s`,
    `kind get kubeconfig --name ${CLUSTER_NAME} >/etc/kind/kubeconfig`,
    "EOS",
    "chmod +x /usr/local/sbin/kind-cluster.sh",
    "",
    "cat >/etc/systemd/system/kind-cluster.service <<'EOU'",
    "[Unit]",
    `Description=Create the ${CLUSTER_NAME} kind cluster and schedule the auto-stop`,
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=oneshot",
    "RemainAfterExit=yes",
    "ExecStart=/usr/local/sbin/kind-cluster.sh",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    "EOU",
    "systemctl daemon-reload",
    "systemctl enable --now kind-cluster.service",
    "",
  ].join("\n");
}

export interface BootstrapStackProps {
  /** Globally unique S3 bucket name for Terraform state. */
  readonly bucketName: string;
}

/**
 * One-off stack, kept in local state, that creates the S3 bucket every other
 * AWS stack stores its state in. The bucket name cannot come from a data
 * source because backend blocks are evaluated before any provider runs.
 */
export class BootstrapStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: BootstrapStackProps) {
    super(scope, id);

    new AwsProvider(this, "aws", { region: REGION, defaultTags: [{ tags: TAGS }] });

    const bucket = new S3Bucket(this, "state", { bucket: props.bucketName });

    new S3BucketVersioningA(this, "state_versioning", {
      bucket: bucket.id,
      versioningConfiguration: { status: "Enabled" },
    });
    new S3BucketServerSideEncryptionConfigurationA(this, "state_encryption", {
      bucket: bucket.id,
      rule: [{ applyServerSideEncryptionByDefault: { sseAlgorithm: "AES256" } }],
    });
    new S3BucketPublicAccessBlock(this, "state_public_access", {
      bucket: bucket.id,
      blockPublicAcls: true,
      blockPublicPolicy: true,
      ignorePublicAcls: true,
      restrictPublicBuckets: true,
    });

    new TerraformOutput(this, "bucket", {
      value: bucket.bucket,
      description: "S3 bucket holding Terraform state for the AWS stacks",
    });
  }
}

export interface AwsKindStackProps {
  /** Bucket created by BootstrapStack. */
  readonly stateBucket: string;
}

export class AwsKindStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: AwsKindStackProps) {
    super(scope, id);

    const backend = new S3Backend(this, {
      bucket: props.stateBucket,
      key: "aws-kind/terraform.tfstate",
      region: REGION,
      encrypt: true,
    });
    // S3-native locking (Terraform >= 1.10) replaces the DynamoDB table. The
    // installed cdktf does not type the option yet, so set it as an override.
    backend.addOverride("use_lockfile", true);

    new AwsProvider(this, "aws", { region: REGION, defaultTags: [{ tags: TAGS }] });

    const lifetime = new TerraformVariable(this, "lifetime_minutes", {
      type: "number",
      default: 60,
      description: "Minutes after boot before the instance stops itself",
    });

    // --- Networking: one public subnet is all a single host needs.
    const vpc = new Vpc(this, "vpc", {
      cidrBlock: "10.42.0.0/16",
      enableDnsHostnames: true,
      tags: { Name: `${CLUSTER_NAME}-vpc` },
    });
    const subnet = new Subnet(this, "public", {
      vpcId: vpc.id,
      cidrBlock: "10.42.1.0/24",
      mapPublicIpOnLaunch: true,
      tags: { Name: `${CLUSTER_NAME}-public` },
    });
    const igw = new InternetGateway(this, "igw", { vpcId: vpc.id });
    const routeTable = new RouteTable(this, "public_rt", { vpcId: vpc.id });
    new Route(this, "default_route", {
      routeTableId: routeTable.id,
      destinationCidrBlock: "0.0.0.0/0",
      gatewayId: igw.id,
    });
    new RouteTableAssociation(this, "public_rta", {
      subnetId: subnet.id,
      routeTableId: routeTable.id,
    });

    // --- Security group: only the ingress ports kind maps to the host.
    // No SSH (SSM Session Manager replaces it) and the API server is only
    // reachable through an SSM port-forward.
    const sg = new SecurityGroup(this, "sg", {
      name: `${CLUSTER_NAME}-host`,
      vpcId: vpc.id,
      description: "kind host: HTTP/HTTPS in, everything out",
    });
    for (const port of [80, 443]) {
      new VpcSecurityGroupIngressRule(this, `ingress_${port}`, {
        securityGroupId: sg.id,
        cidrIpv4: "0.0.0.0/0",
        ipProtocol: "tcp",
        fromPort: port,
        toPort: port,
      });
    }
    new VpcSecurityGroupEgressRule(this, "egress_all", {
      securityGroupId: sg.id,
      cidrIpv4: "0.0.0.0/0",
      ipProtocol: "-1",
    });

    // --- IAM: SSM agent needs a role; nothing else.
    const role = new IamRole(this, "role", {
      name: `${CLUSTER_NAME}-host`,
      assumeRolePolicy: JSON.stringify({
        Version: "2012-10-17",
        Statement: [
          {
            Effect: "Allow",
            Principal: { Service: "ec2.amazonaws.com" },
            Action: "sts:AssumeRole",
          },
        ],
      }),
    });
    new IamRolePolicyAttachment(this, "role_ssm", {
      role: role.name,
      policyArn: SSM_CORE_POLICY,
    });
    const profile = new IamInstanceProfile(this, "profile", {
      name: `${CLUSTER_NAME}-host`,
      role: role.name,
    });

    // --- The host.
    const ami = new DataAwsSsmParameter(this, "al2023_ami", {
      name: AL2023_AMI_PARAMETER,
    });

    const host = new Instance(this, "host", {
      ami: ami.value,
      instanceType: INSTANCE_TYPE,
      subnetId: subnet.id,
      vpcSecurityGroupIds: [sg.id],
      iamInstanceProfile: profile.name,
      userData: userData(lifetime.stringValue),
      userDataReplaceOnChange: true,
      instanceInitiatedShutdownBehavior: "stop",
      metadataOptions: { httpTokens: "required", httpEndpoint: "enabled" },
      rootBlockDevice: { volumeSize: 30, volumeType: "gp3", deleteOnTermination: true },
      tags: { Name: `${CLUSTER_NAME}-host` },
    });

    new TerraformOutput(this, "instance_id", {
      value: host.id,
      description: "EC2 instance id (used by make aws-start / aws-stop / aws-tunnel)",
    });
    new TerraformOutput(this, "public_ip", {
      value: host.publicIp,
      description: "Public IP; ingress on :80/:443 once an ingress controller is installed",
    });
  }
}

// Only synthesize when run directly by `cdktf synth`, not when imported by tests.
if (require.main === module) {
  const stateBucket = process.env.STATE_BUCKET;
  if (!stateBucket) {
    throw new Error("STATE_BUCKET is not set; run through the Makefile (make aws-synth)");
  }
  const app = new App();
  new BootstrapStack(app, "aws-bootstrap", { bucketName: stateBucket });
  new AwsKindStack(app, "aws-kind", { stateBucket });
  app.synth();
}
