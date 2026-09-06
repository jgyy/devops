import "cdktf/lib/testing/adapters/jest";
import { Testing } from "cdktf";
import {
  AWS_SECRET_NAME,
  CHART_VERSION,
  dashboardFiles,
  DashboardStack,
  NAMESPACE,
  REGION,
  RELEASE_NAME,
  STEAMPIPE_IMAGE,
  STEAMPIPE_PORT,
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

describe("Steampipe", () => {
  const { parsed } = synthLocal();
  const deployment = firstResource(parsed, "kubernetes_deployment_v1");
  const container = deployment.spec.template.spec.container[0];

  it("runs the pinned image, installs the aws plugin and listens on the network", () => {
    expect(container.image).toBe(STEAMPIPE_IMAGE);
    expect(container.command.join(" ")).toContain("steampipe plugin install aws");
    expect(container.command.join(" ")).toContain("--database-listen network");
    expect(container.port[0].container_port).toBe(STEAMPIPE_PORT);
    expect(container.readiness_probe.tcp_socket.port).toBe(String(STEAMPIPE_PORT));
  });

  it("takes its password from the shared Secret and the region from the ConfigMap", () => {
    const env = container.env.find((e: any) => e.name === "STEAMPIPE_DATABASE_PASSWORD");
    expect(env.value_from.secret_key_ref).toEqual({
      name: STEAMPIPE_SECRET_NAME,
      key: "STEAMPIPE_DATABASE_PASSWORD",
    });
    const cm = Object.values(parsed.resource.kubernetes_config_map_v1 as any).find(
      (c: any) => c.metadata.name === "steampipe-config",
    ) as any;
    expect(cm.data["aws.spc"]).toContain(`regions = ["${REGION}"]`);
    expect(container.volume_mount[0]).toMatchObject({
      mount_path: "/home/steampipe/.steampipe/config/aws.spc",
      sub_path: "aws.spc",
    });
  });

  it("injects AWS keys only on the local cluster", () => {
    expect(container.env_from[0].secret_ref.name).toBe(AWS_SECRET_NAME);
    const aws = firstResource(synthAws().parsed, "kubernetes_deployment_v1");
    expect(aws.spec.template.spec.container[0].env_from).toBeUndefined();
  });

  it("exposes a Service Grafana can reach by name", () => {
    const svc = firstResource(parsed, "kubernetes_service_v1");
    expect(svc.metadata.name).toBe("steampipe");
    expect(svc.spec.selector).toEqual({ app: "steampipe" });
    expect(svc.spec.port[0]).toMatchObject({ port: STEAMPIPE_PORT, target_port: String(STEAMPIPE_PORT) });
  });
});

describe("dashboard ConfigMaps", () => {
  const { parsed } = synthLocal();
  const maps = Object.values(parsed.resource.kubernetes_config_map_v1 as any).filter((c: any) =>
    c.metadata.name.startsWith("dashboard-"),
  ) as any[];

  it("creates one labelled ConfigMap per JSON file", () => {
    expect(maps).toHaveLength(dashboardFiles().length);
    expect(maps.length).toBeGreaterThan(0);
    for (const cm of maps) {
      expect(cm.metadata.labels).toEqual({ grafana_dashboard: "1" });
      expect(cm.metadata.namespace).toBe(NAMESPACE);
      for (const [file, body] of Object.entries(cm.data)) {
        expect(file).toMatch(/\.json$/);
        expect(() => JSON.parse(body as string)).not.toThrow();
      }
    }
  });

  it("ships the AWS resources dashboard using both AWS datasources", () => {
    const cm = maps.find((c) => c.metadata.name === "dashboard-aws-resources");
    const dashboard = JSON.parse(cm.data["aws-resources.json"]);
    const uids = new Set(dashboard.panels.map((p: any) => p.datasource.uid));
    expect(uids).toEqual(new Set(["cloudwatch", "steampipe"]));
    const sql = dashboard.panels
      .filter((p: any) => p.datasource.uid === "steampipe")
      .map((p: any) => p.targets[0].rawSql as string);
    for (const query of sql) {
      expect(query).toContain("'Project' = 'devops'");
    }
  });
});
