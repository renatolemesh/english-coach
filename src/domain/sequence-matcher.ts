// difflib-style SequenceMatcher (Ratcliff-Obershelp) for sequences of strings, with no junk and
// no autojunk heuristic (the only way the project uses it). The tie-breaking of findLongestMatch
// is part of the contract: the tests compare against reference opcodes and ratios.

export type OpTag = "replace" | "delete" | "insert" | "equal";
/** difflib opcode: a[i1:i2] -> b[j1:j2]. */
export type Opcode = [tag: OpTag, i1: number, i2: number, j1: number, j2: number];
/** difflib Match: a[a:a+size] == b[b:b+size]. */
export type Match = [a: number, b: number, size: number];

export class SequenceMatcher {
  private readonly a: readonly string[];
  private readonly b: readonly string[];
  private readonly b2j = new Map<string, number[]>();
  private matchingBlocks: Match[] | null = null;
  private opcodes: Opcode[] | null = null;

  constructor(a: readonly string[], b: readonly string[]) {
    this.a = a;
    this.b = b;
    // __chain_b without junk or popular elements (autojunk=False)
    b.forEach((elt, i) => {
      const indices = this.b2j.get(elt);
      if (indices) indices.push(i);
      else this.b2j.set(elt, [i]);
    });
  }

  /** Longest matching block in a[alo:ahi] and b[blo:bhi]; ties: earliest in a, then in b. */
  findLongestMatch(
    alo = 0,
    ahi: number = this.a.length,
    blo = 0,
    bhi: number = this.b.length,
  ): Match {
    const { a, b, b2j } = this;
    let besti = alo;
    let bestj = blo;
    let bestsize = 0;
    let j2len = new Map<number, number>();
    for (let i = alo; i < ahi; i++) {
      const newj2len = new Map<number, number>();
      for (const j of b2j.get(a[i] as string) ?? []) {
        if (j < blo) continue;
        if (j >= bhi) break;
        const k = (j2len.get(j - 1) ?? 0) + 1;
        newj2len.set(j, k);
        if (k > bestsize) {
          besti = i - k + 1;
          bestj = j - k + 1;
          bestsize = k;
        }
      }
      j2len = newj2len;
    }
    // Extend the match with equal (non-junk) neighbours; a no-op without junk, kept so the
    // algorithm stays complete.
    while (besti > alo && bestj > blo && a[besti - 1] === b[bestj - 1]) {
      besti--;
      bestj--;
      bestsize++;
    }
    while (
      besti + bestsize < ahi &&
      bestj + bestsize < bhi &&
      a[besti + bestsize] === b[bestj + bestsize]
    ) {
      bestsize++;
    }
    return [besti, bestj, bestsize];
  }

  getMatchingBlocks(): Match[] {
    if (this.matchingBlocks) return this.matchingBlocks;
    const la = this.a.length;
    const lb = this.b.length;
    const queue: [number, number, number, number][] = [[0, la, 0, lb]];
    const blocks: Match[] = [];
    for (let item = queue.pop(); item; item = queue.pop()) {
      const [alo, ahi, blo, bhi] = item;
      const x = this.findLongestMatch(alo, ahi, blo, bhi);
      const [i, j, k] = x;
      if (k) {
        blocks.push(x);
        if (alo < i && blo < j) queue.push([alo, i, blo, j]);
        if (i + k < ahi && j + k < bhi) queue.push([i + k, ahi, j + k, bhi]);
      }
    }
    blocks.sort((x, y) => x[0] - y[0] || x[1] - y[1] || x[2] - y[2]);
    // collapse adjacent blocks
    let i1 = 0;
    let j1 = 0;
    let k1 = 0;
    const nonAdjacent: Match[] = [];
    for (const [i2, j2, k2] of blocks) {
      if (i1 + k1 === i2 && j1 + k1 === j2) {
        k1 += k2;
      } else {
        if (k1) nonAdjacent.push([i1, j1, k1]);
        i1 = i2;
        j1 = j2;
        k1 = k2;
      }
    }
    if (k1) nonAdjacent.push([i1, j1, k1]);
    nonAdjacent.push([la, lb, 0]);
    this.matchingBlocks = nonAdjacent;
    return nonAdjacent;
  }

  getOpcodes(): Opcode[] {
    if (this.opcodes) return this.opcodes;
    let i = 0;
    let j = 0;
    const answer: Opcode[] = [];
    for (const [ai, bj, size] of this.getMatchingBlocks()) {
      let tag: OpTag | "" = "";
      if (i < ai && j < bj) tag = "replace";
      else if (i < ai) tag = "delete";
      else if (j < bj) tag = "insert";
      if (tag) answer.push([tag, i, ai, j, bj]);
      i = ai + size;
      j = bj + size;
      if (size) answer.push(["equal", ai, i, bj, j]);
    }
    this.opcodes = answer;
    return answer;
  }

  /** 2 * matches / (len(a) + len(b)); 1.0 when both are empty. */
  ratio(): number {
    const matches = this.getMatchingBlocks().reduce((sum, [, , size]) => sum + size, 0);
    const length = this.a.length + this.b.length;
    return length ? (2.0 * matches) / length : 1.0;
  }
}
