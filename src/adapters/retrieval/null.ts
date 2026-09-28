/** Retriever that returns nothing (RAG disabled). */
import type { Retriever } from "../../ports/retriever.js";

export class NullRetriever implements Retriever {
  async retrieve(): Promise<string> {
    return "(none)";
  }
  async rememberMistakes(): Promise<void> {}
}
