import { EvolveError } from "../core/errors.js";

const DIGEST_REFERENCE = /^(?:[a-z0-9._/-]+(?::[a-zA-Z0-9._-]+)?@)?sha256:[a-f0-9]{64}$/;

export class ImagePolicy {
  private readonly allowed: Set<string>;

  public constructor(allowedImages: Iterable<string>, private readonly defaultImage?: string) {
    this.allowed = new Set([...allowedImages].map((value) => value.trim()).filter(Boolean));
    if (defaultImage) this.allowed.add(defaultImage);
    for (const image of this.allowed) {
      if (!DIGEST_REFERENCE.test(image)) {
        throw new EvolveError("DOCKER_IMAGE_UNPINNED", `Configured Docker image is not sha256-pinned: ${image}`);
      }
    }
  }

  public resolve(requested?: string): string {
    const image = requested?.trim() || this.defaultImage;
    if (!image) {
      throw new EvolveError(
        "DOCKER_IMAGE_REQUIRED",
        "No Docker image was requested and EVOLVE_DOCKER_DEFAULT_IMAGE is not configured",
      );
    }
    if (!DIGEST_REFERENCE.test(image)) {
      throw new EvolveError("DOCKER_IMAGE_UNPINNED", "Docker images must be pinned to an exact sha256 digest");
    }
    if (!this.allowed.has(image)) {
      throw new EvolveError("DOCKER_IMAGE_DENIED", "Docker image is not in EVOLVE_DOCKER_ALLOWED_IMAGES");
    }
    return image;
  }

  public list(): string[] {
    return [...this.allowed].sort();
  }

  public getDefault(): string | undefined {
    return this.defaultImage;
  }
}
