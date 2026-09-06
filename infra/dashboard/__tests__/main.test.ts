import "cdktf/lib/testing/adapters/jest";
import { Testing } from "cdktf";
import {
  CHART_VERSION,
  DashboardStack,
  NAMESPACE,
  RELEASE_NAME,
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
