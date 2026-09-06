import { App, TerraformOutput, TerraformStack } from "cdktf";
import { Construct } from "constructs";
import { KindProvider } from "./.gen/providers/kind/provider";
import { Cluster, ClusterKindConfigNode } from "./.gen/providers/kind/cluster";

export const CLUSTER_NAME = "devops-local";

/**
 * Node topology for the local cluster.
 *
 * kind runs each node as a Docker container. Only ports declared in
 * `extraPortMappings` are reachable from the host, and mappings cannot be
 * changed without recreating the cluster, so 80/443 are reserved up front for
 * a future ingress controller. The control-plane node carries the
 * `ingress-ready` label and a kubeadm patch so Ingress NGINX's kind manifest
 * can schedule onto it without any further cluster changes.
 */
export function nodeTopology(): ClusterKindConfigNode[] {
  const httpPorts = [80, 443].map((port) => ({
    containerPort: port,
    hostPort: port,
    protocol: "TCP",
  }));

  return [
    {
      role: "control-plane",
      labels: { "ingress-ready": "true" },
      kubeadmConfigPatches: [
        [
          "kind: InitConfiguration",
          "nodeRegistration:",
          "  kubeletExtraArgs:",
          '    node-labels: "ingress-ready=true"',
        ].join("\n"),
      ],
      extraPortMappings: httpPorts,
    },
    { role: "worker" },
    { role: "worker" },
  ];
}

export class KindClusterStack extends TerraformStack {
  constructor(scope: Construct, id: string) {
    super(scope, id);

    new KindProvider(this, "kind");

    const cluster = new Cluster(this, "cluster", {
      name: CLUSTER_NAME,
      waitForReady: true,
      kindConfig: {
        kind: "Cluster",
        apiVersion: "kind.x-k8s.io/v1alpha4",
        nodeAttribute: nodeTopology(),
      },
    });

    new TerraformOutput(this, "kubeconfig_path", {
      value: cluster.kubeconfigPath,
      description: "Path to the kubeconfig for the local cluster",
    });
    new TerraformOutput(this, "endpoint", {
      value: cluster.endpoint,
      description: "Kubernetes API server endpoint",
    });
  }
}

// Only synthesize when run directly by `cdktf synth`, not when imported by tests.
if (require.main === module) {
  const app = new App();
  new KindClusterStack(app, "local-kind");
  app.synth();
}
