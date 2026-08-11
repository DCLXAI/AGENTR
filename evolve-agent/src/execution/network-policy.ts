import { EvolveError } from "../core/errors.js";

const NETWORK_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_.-]{0,127}$/;
const RESERVED_UNSAFE = new Set(["host", "bridge", "default", "container"]);

export interface ResolvedNetwork {
  name: string;
  enforcement: string;
}

export class DockerNetworkPolicy {
  private readonly allowed: Set<string>;

  public constructor(allowedNetworks: Iterable<string>) {
    this.allowed = new Set(["none", ...[...allowedNetworks].map((value) => value.trim()).filter(Boolean)]);
    for (const network of this.allowed) {
      if (!NETWORK_NAME.test(network)) throw new EvolveError("DOCKER_NETWORK_INVALID", `Invalid configured network: ${network}`);
      if (RESERVED_UNSAFE.has(network)) {
        throw new EvolveError("DOCKER_NETWORK_DENIED", `Unsafe network cannot be allowlisted: ${network}`);
      }
    }
  }

  public resolve(requested: string): ResolvedNetwork {
    const network = requested.trim() || "none";
    if (!NETWORK_NAME.test(network)) throw new EvolveError("DOCKER_NETWORK_INVALID", "Invalid Docker network name");
    if (RESERVED_UNSAFE.has(network)) {
      throw new EvolveError(
        "DOCKER_NETWORK_DENIED",
        `${network} bypasses the hardened network boundary; use none or an operator-managed network`,
      );
    }
    if (!this.allowed.has(network)) {
      throw new EvolveError("DOCKER_NETWORK_DENIED", "Docker network is not in EVOLVE_DOCKER_ALLOWED_NETWORKS");
    }
    return {
      name: network,
      enforcement: network === "none" ? "deny-all" : `operator-managed:${network}`,
    };
  }

  public list(): string[] {
    return [...this.allowed].sort();
  }
}
