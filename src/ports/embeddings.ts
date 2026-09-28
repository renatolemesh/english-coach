export interface Embeddings {
  readonly dim: number;
  embedDocuments(texts: string[]): Promise<number[][]>;
  embedQuery(text: string): Promise<number[]>;
  /** Load a local model ahead of the first message (absent for API backends). */
  load?(): Promise<void>;
}
