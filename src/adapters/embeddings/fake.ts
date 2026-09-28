/** Deterministic bag-of-words hashing embeddings (tests only: similar words -> similar vectors).
 * The vectors are pinned by golden values in test/rag/embeddings.test.ts. */
import { createHash } from "node:crypto";
import type { Embeddings } from "../../ports/embeddings.js";

const WORD = /[a-z']+/g;

export class HashEmbeddings implements Embeddings {
  constructor(readonly dim = 1536) {}

  vector(text: string): number[] {
    const vec = new Array<number>(this.dim).fill(0);
    const dim = BigInt(this.dim);
    for (const [word] of text.toLowerCase().matchAll(WORD)) {
      const h = BigInt(`0x${createHash("md5").update(word, "utf8").digest("hex")}`);
      const i = Number(h % dim);
      vec[i] = (vec[i] ?? 0) + ((h >> 64n) % 2n ? 1 : -1);
    }
    const norm = Math.sqrt(vec.reduce((s, v) => s + v * v, 0)) || 1;
    return vec.map((v) => v / norm);
  }

  async embedDocuments(texts: string[]): Promise<number[][]> {
    return texts.map((t) => this.vector(t));
  }

  async embedQuery(text: string): Promise<number[]> {
    return this.vector(text);
  }
}
