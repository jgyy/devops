import "cdktf/lib/testing/adapters/jest";
import { Testing } from "cdktf";
import {
  AWS_SECRET_NAME,
  CHART_VERSION,
  DashboardStack,
  NAMESPACE,
  REGION,
  RELEASE_NAME,
  STEAMPIPE_SECRET_NAME,
} from "../main";

const KUBECONFIG = "/tmp/test-kubeconfig";

export function firstResource(parsed: any, type: string): any {
  return Object.values(parsed.resource[type])[0];
}

export function synthLocal() {
  const app = Testing.app();
  const stack = new DashboardStack(app, "dashboard-test-local", {
    kubeconfigPath: KUBECONFIG,
    awsCredentials: "secret",
  });
  return { stack, parsed: JSON.parse(Testing.synth(stack)) };
}

export function synthAws() {
  const app = Testing.app();
  const stack = new DashboardStack(app, "dashboard-test-aws", {
    kubeconfigPath: KUBECONFIG,
    awsCredentials: "instance-role",
  });
  return { stack, parsed: JSON.parse(Testing.synth(stack)) };
}

describe("DashboardStack providers and namespace", () => {
  const { stack, parsed } = synthLocal();

  it("points both providers at the given kubeconfig", () => {
    expect(Object.values(parsed.provider.kubernetes)[0]).toMatchObject({ config_path: KUBECONFIG });
    expect(Object.values(parsed.provider.helm)[0]).toMatchObject({
      kubernetes: { config_path: KUBECONFIG },
    });
  });

  it("creates the dashboard namespace", () => {
    expect(firstResource(parsed, "kubernetes_namespace_v1").metadata.name).toBe(NAMESPACE);
  });

  it("produces valid Terraform", () => {
    expect(Testing.fullSynth(stack)).toBeValidTerraform();
  });
});

describe("kube-prometheus-stack release", () => {
  const { parsed } = synthLocal();
  const release = firstResource(parsed, "helm_release");
  const values = JSON.parse(release.values[0]);

  it("installs the pinned chart into the dashboard namespace", () => {
    expect(release).toMatchObject({
      name: RELEASE_NAME,
      chart: "kube-prometheus-stack",
      repository: "https://prometheus-community.github.io/helm-charts",
      version: CHART_VERSION,
      namespace: NAMESPACE,
    });
  });

  it("disables alertmanager and keeps Prometheus retention short", () => {
    expect(values.alertmanager.enabled).toBe(false);
    expect(values.prometheus.prometheusSpec.retention).toBe("2h");
  });

  it("loads dashboards from labelled ConfigMaps", () => {
    expect(values.grafana.sidecar.dashboards.enabled).toBe(true);
    expect(values.grafana.sidecar.dashboards.label).toBe("grafana_dashboard");
  });

  it("takes the Grafana admin password from a variable", () => {
    expect(parsed.variable.grafana_admin_password.default).toBe("admin");
    expect(values.grafana.adminPassword).toBe("${var.grafana_admin_password}");
  });
});

describe("AWS credentials", () => {
  it("copies the CLI keys into a Secret on the local cluster", () => {
    const { parsed } = synthLocal();
    const secret = Object.values(parsed.resource.kubernetes_secret_v1 as any).find(
      (s: any) => s.metadata.name === AWS_SECRET_NAME,
    ) as any;
    expect(secret.metadata.namespace).toBe(NAMESPACE);
    expect(secret.data).toEqual({
      AWS_ACCESS_KEY_ID: "${var.aws_access_key_id}",
      AWS_SECRET_ACCESS_KEY: "${var.aws_secret_access_key}",
      AWS_SESSION_TOKEN: "${var.aws_session_token}",
    });
    expect(parsed.variable.aws_access_key_id.sensitive).toBe(true);
    expect(parsed.variable.aws_session_token.default).toBe("");
    const values = JSON.parse(firstResource(parsed, "helm_release").values[0]);
    expect(values.grafana.envFromSecrets.map((s: any) => s.name)).toEqual([
      STEAMPIPE_SECRET_NAME,
      AWS_SECRET_NAME,
    ]);
  });

  it("relies on the instance role on the AWS cluster", () => {
    const { parsed } = synthAws();
    const names = Object.values(parsed.resource.kubernetes_secret_v1 as any).map(
      (s: any) => s.metadata.name,
    );
    expect(names).not.toContain(AWS_SECRET_NAME);
    expect(parsed.variable.aws_access_key_id).toBeUndefined();
    const values = JSON.parse(firstResource(parsed, "helm_release").values[0]);
    expect(values.grafana.envFromSecrets.map((s: any) => s.name)).toEqual([STEAMPIPE_SECRET_NAME]);
  });
});

describe("Grafana datasources", () => {
  const { parsed } = synthLocal();
  const values = JSON.parse(firstResource(parsed, "helm_release").values[0]);
  const sources = values.grafana.additionalDataSources as any[];

  it("adds CloudWatch using the default credential chain", () => {
    const cw = sources.find((s) => s.uid === "cloudwatch");
    expect(cw).toMatchObject({
      type: "cloudwatch",
      jsonData: { authType: "default", defaultRegion: REGION },
    });
  });

  it("adds Steampipe as a PostgreSQL datasource", () => {
    const sp = sources.find((s) => s.uid === "steampipe");
    expect(sp).toMatchObject({
      type: "grafana-postgresql-datasource",
      url: `steampipe.${NAMESPACE}.svc:9193`,
      user: "steampipe",
      jsonData: { database: "steampipe", sslmode: "disable" },
      secureJsonData: { password: "$STEAMPIPE_DATABASE_PASSWORD" },
    });
  });

  it("stores the Steampipe password in a Secret Grafana reads as env", () => {
    const secret = Object.values(parsed.resource.kubernetes_secret_v1 as any).find(
      (s: any) => s.metadata.name === STEAMPIPE_SECRET_NAME,
    ) as any;
    expect(secret.data).toEqual({ STEAMPIPE_DATABASE_PASSWORD: "${var.steampipe_password}" });
  });
});
