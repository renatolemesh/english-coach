/**
 * Retriever over the three collections, each searched with its own filters and k:
 *
 * - lesson_content: this topic (or any, for free-text topics), levels around the student's;
 * - grammar_notes: any topic, levels around the student's;
 * - student_mistakes: only this student's own past mistakes (never another student's).
 *
 * Results are grouped under headings and cut to RAG_MAX_CONTEXT_CHARS (~4 chars per token).
 */
import type { Settings } from "../config.js";
import type { Evaluation } from "../domain/evaluation.js";
import { LEVELS, SUGGESTED_TOPICS } from "../domain/topics.js";
import { checkText } from "../guardrails/input-rules.js";
import { getLogger } from "../logging.js";
import type { Embeddings } from "../ports/embeddings.js";
import type { Retriever } from "../ports/retriever.js";
import { Document, SearchFilters, type VectorStore } from "../ports/vector-store.js";
import { NoopReranker, type Reranker } from "./reranker.js";
import { type Collection, SECTIONS } from "./sections.js";

const log = getLogger("coach.rag.knowledge_base");

export const MAX_MISTAKES_PER_STUDENT = 50; // newest kept; older ones age out of the memory

/** The student's level and its neighbours (B1 -> A2, B1, B2). */
export function nearbyLevels(level: string): string[] {
  const i = (LEVELS as readonly string[]).indexOf(level);
  if (i < 0) return [...LEVELS];
  return LEVELS.slice(Math.max(0, i - 1), i + 2);
}

type KbSettings = Pick<Settings, "ragK" | "ragMaxContextChars" | "maxTextChars">;

export interface KnowledgeBaseOptions {
  reranker?: Reranker;
  maxMistakesPerStudent?: number;
}

export class KnowledgeBase implements Retriever {
  private readonly reranker: Reranker;
  private readonly maxMistakes: number;

  constructor(
    readonly store: VectorStore,
    readonly embeddings: Embeddings,
    private readonly settings: KbSettings,
    opts: KnowledgeBaseOptions = {},
  ) {
    this.reranker = opts.reranker ?? new NoopReranker();
    this.maxMistakes = opts.maxMistakesPerStudent ?? MAX_MISTAKES_PER_STUDENT;
  }

  /** Load a local embedding model before the first message (no-op for API backends). */
  async warmUp(): Promise<void> {
    await this.embeddings.load?.();
  }

  private filters(
    collection: Collection,
    topic: string,
    level: string,
    userId: number,
  ): SearchFilters {
    const levels = nearbyLevels(level);
    if (collection === "lesson_content") {
      const seeded = SUGGESTED_TOPICS.includes(topic); // free-text topics have no seed content
      return SearchFilters.parse({ collection, topic: seeded ? topic : null, levels });
    }
    if (collection === "grammar_notes") return SearchFilters.parse({ collection, levels });
    return SearchFilters.parse({ collection, userId });
  }

  async retrieve(query: string, topic: string, level: string, userId: number): Promise<string> {
    const k = this.settings.ragK;
    const qvec = await this.embeddings.embedQuery(query); // one embedding for all collections
    const results = await Promise.allSettled(
      SECTIONS.map(([c]) =>
        this.store.search(query, this.filters(c, topic, level, userId), k * 2, qvec),
      ),
    );
    const sections: [string, Document[]][] = [];
    for (const [i, [collection, title]] of SECTIONS.entries()) {
      const found = results[i];
      if (!found) continue;
      if (found.status === "rejected") {
        log.warning("rag_search_failed", { collection, error: String(found.reason) });
        continue;
      }
      const docs = await this.reranker.rerank(query, found.value, k);
      if (docs.length) sections.push([title, docs]);
    }
    return this.format(sections);
  }

  private format(sections: [string, Document[]][]): string {
    let budget = this.settings.ragMaxContextChars;
    const lines: string[] = [];
    for (const [title, docs] of sections) {
      const header = `## ${title}`;
      budget -= header.length + 1;
      const section: string[] = [];
      for (const doc of docs) {
        const line = `- ${doc.content}`;
        if (line.length + 1 > budget) break;
        section.push(line);
        budget -= line.length + 1;
      }
      if (!section.length) break; // no room for any item: drop the header too
      lines.push(header, ...section);
    }
    return lines.length ? lines.join("\n") : "(none)";
  }

  /** Mistake text quotes the student and is replayed into their future prompts: anything that
   * looks like an injection is not stored (stored prompt injection, OWASP LLM01). */
  async rememberMistakes(userId: number, topic: string, evaluation: Evaluation): Promise<void> {
    const real = evaluation.mistakes.filter((m) => m.type !== "unclear"); // unclear: audio noise
    const safe = real.filter(
      (m) => checkText(`${m.original} ${m.correction}`, this.settings) !== "injection",
    );
    const docs = safe.map((m) =>
      Document.parse({
        collection: "student_mistakes",
        content: `Said '${m.original}' instead of '${m.correction}' (${m.type}).`,
        topic,
        kind: m.type,
        userId,
        metadata: { explanation: m.explanation },
      }),
    );
    if (safe.length < real.length) {
      log.warning("mistake_not_stored", { reason: "injection", user_id: userId });
    }
    if (await this.store.upsert(docs)) {
      await this.store.trimUserDocuments(userId, this.maxMistakes);
    }
  }
}
