import * as path from "node:path";
import { App, TerraformOutput, TerraformStack, TerraformVariable } from "cdktf";
import { Construct } from "constructs";
import { HelmProvider } from "./.gen/providers/helm/provider";
import { Release } from "./.gen/providers/helm/release";
import { KubernetesProvider } from "./.gen/providers/kubernetes/provider";
import { NamespaceV1 } from "./.gen/providers/kubernetes/namespace-v1";
import { SecretV1 } from "./.gen/providers/kubernetes/secret-v1";

export const REGION = "ap-southeast-1";
export const NAMESPACE = "dashboard";
export const RELEASE_NAME = "kube-prometheus-stack";
export const CHART_VERSION = "89.2.2";
const CHART_REPO = "https://prometheus-community.github.io/helm-charts";
export const AWS_SECRET_NAME = "aws-credentials";
export const STEAMPIPE_SECRET_NAME = "steampipe-db";
export const STEAMPIPE_PORT = 9193;

/** Where the two cluster stacks leave their kubeconfigs, relative to this file. */
export const KUBECONFIG_LOCAL = path.resolve(
  __dirname,
  "../local-kind/cdktf.out/stacks/local-kind/devops-local-config",
);
export const KUBECONFIG_AWS = path.resolve(__dirname, "../aws-kind/kubeconfig");

export interface DashboardStackProps {
  /** Kubeconfig both providers use to reach the cluster. */
  readonly kubeconfigPath: string;
  /**
   * `secret`: AWS keys are copied into a Secret (local cluster).
   * `instance-role`: pods use the EC2 instance role through IMDS (AWS cluster).
   */
  readonly awsCredentials: "secret" | "instance-role";
}

/**
 * Helm values for kube-prometheus-stack. Kept as a function so tests can
 * inspect it. Datasource secrets are `$VAR` references that Grafana expands
 * from its environment, which is populated from the listed Secrets.
 */
export function grafanaValues(props: DashboardStackProps, adminPassword: string): object {
  const envFromSecrets = [{ name: STEAMPIPE_SECRET_NAME }];
  if (props.awsCredentials === "secret") {
    envFromSecrets.push({ name: AWS_SECRET_NAME });
  }
  return {
    alertmanager: { enabled: false },
    prometheus: {
      prometheusSpec: {
        retention: "2h",
        // kind has no persistent volumes worth keeping; an emptyDir is enough.
        storageSpec: { emptyDir: { sizeLimit: "1Gi" } },
      },
    },
    grafana: {
      adminPassword,
      envFromSecrets,
      sidecar: { dashboards: { enabled: true, label: "grafana_dashboard", labelValue: "1" } },
      additionalDataSources: [
        {
          name: "CloudWatch",
          uid: "cloudwatch",
          type: "cloudwatch",
          access: "proxy",
          jsonData: { authType: "default", defaultRegion: REGION },
        },
        {
          name: "Steampipe",
          uid: "steampipe",
          type: "grafana-postgresql-datasource",
          access: "proxy",
          url: `steampipe.${NAMESPACE}.svc:${STEAMPIPE_PORT}`,
          user: "steampipe",
          jsonData: { database: "steampipe", sslmode: "disable", postgresVersion: 1400 },
          secureJsonData: { password: "$STEAMPIPE_DATABASE_PASSWORD" },
        },
      ],
    },
  };
}

export class DashboardStack extends TerraformStack {
  constructor(scope: Construct, id: string, props: DashboardStackProps) {
    super(scope, id);

    new KubernetesProvider(this, "kubernetes", { configPath: props.kubeconfigPath });
    new HelmProvider(this, "helm", { kubernetes: { configPath: props.kubeconfigPath } });

    const adminPassword = new TerraformVariable(this, "grafana_admin_password", {
      type: "string",
      default: "admin",
      sensitive: true,
      description: "Grafana admin password; the UI is only reachable via port-forward",
    });

    const ns = new NamespaceV1(this, "namespace", { metadata: { name: NAMESPACE } });

    const steampipePassword = new TerraformVariable(this, "steampipe_password", {
      type: "string",
      default: "steampipe",
      sensitive: true,
      description: "Password for the in-cluster Steampipe database",
    });
    new SecretV1(this, "steampipe_secret", {
      metadata: { name: STEAMPIPE_SECRET_NAME, namespace: NAMESPACE },
      data: { STEAMPIPE_DATABASE_PASSWORD: steampipePassword.stringValue },
      dependsOn: [ns],
    });

    if (props.awsCredentials === "secret") {
      const vars: Record<string, TerraformVariable> = {};
      for (const [key, def] of [
        ["aws_access_key_id", undefined],
        ["aws_secret_access_key", undefined],
        ["aws_session_token", ""],
      ] as const) {
        vars[key] = new TerraformVariable(this, key, {
          type: "string",
          sensitive: true,
          ...(def !== undefined ? { default: def } : {}),
          description: `AWS credential copied into the ${AWS_SECRET_NAME} Secret`,
        });
      }
      new SecretV1(this, "aws_secret", {
        metadata: { name: AWS_SECRET_NAME, namespace: NAMESPACE },
        data: {
          AWS_ACCESS_KEY_ID: vars.aws_access_key_id.stringValue,
          AWS_SECRET_ACCESS_KEY: vars.aws_secret_access_key.stringValue,
          AWS_SESSION_TOKEN: vars.aws_session_token.stringValue,
        },
        dependsOn: [ns],
      });
    }

    new Release(this, "kube_prometheus_stack", {
      name: RELEASE_NAME,
      repository: CHART_REPO,
      chart: "kube-prometheus-stack",
      version: CHART_VERSION,
      namespace: NAMESPACE,
      values: [JSON.stringify(grafanaValues(props, adminPassword.stringValue))],
      wait: true,
      timeout: 900,
      dependsOn: [ns],
    });

    new TerraformOutput(this, "grafana_service", {
      value: `${RELEASE_NAME}-grafana.${NAMESPACE}.svc`,
      description: "Grafana Service; reach it with make dashboard-open",
    });
  }
}

// Only synthesize when run directly by `cdktf synth`, not when imported by tests.
if (require.main === module) {
  const app = new App();
  new DashboardStack(app, "dashboard-local", {
    kubeconfigPath: KUBECONFIG_LOCAL,
    awsCredentials: "secret",
  });
  new DashboardStack(app, "dashboard-aws", {
    kubeconfigPath: KUBECONFIG_AWS,
    awsCredentials: "instance-role",
  });
  app.synth();
}
