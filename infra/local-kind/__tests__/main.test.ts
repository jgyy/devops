import "cdktf/lib/testing/adapters/jest";
import { Testing } from "cdktf";
import { Cluster } from "../.gen/providers/kind/cluster";
import { KindClusterStack } from "../main";

describe("KindClusterStack", () => {
  const app = Testing.app();
  const stack = new KindClusterStack(app, "test");
  const synthesized = Testing.synth(stack);
  const parsed = JSON.parse(synthesized);
  const cluster = Object.values(parsed.resource.kind_cluster)[0] as any;

  it("declares a kind_cluster resource named devops-local", () => {
    expect(synthesized).toHaveResourceWithProperties(Cluster, {
      name: "devops-local",
    });
  });

  it("has one control-plane and two worker nodes", () => {
    const roles = cluster.kind_config.node.map((n: any) => n.role);
    expect(roles.filter((r: string) => r === "control-plane")).toHaveLength(1);
    expect(roles.filter((r: string) => r === "worker")).toHaveLength(2);
  });

  it("maps host ports 80 and 443 onto the control-plane node", () => {
    const cp = cluster.kind_config.node.find((n: any) => n.role === "control-plane");
    const hostPorts = cp.extra_port_mappings.map((m: any) => m.host_port).sort();
    expect(hostPorts).toEqual([443, 80].sort());
  });

  it("waits for the cluster to be ready", () => {
    expect(cluster.wait_for_ready).toBe(true);
  });

  it("produces valid Terraform", () => {
    expect(Testing.fullSynth(stack)).toBeValidTerraform();
  });
});
