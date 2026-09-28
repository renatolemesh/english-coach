/** Fake ImageRenderer: a valid 1x1 PNG. */
import type { Evaluation } from "../../domain/evaluation.js";
import type { ImageRenderer } from "../../ports/media.js";

export const ONE_PIXEL_PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
  "base64",
);

export class FakeImageRenderer implements ImageRenderer {
  readonly calls: Evaluation[] = [];

  async render(evaluation: Evaluation): Promise<Buffer> {
    this.calls.push(evaluation);
    return ONE_PIXEL_PNG;
  }
}
