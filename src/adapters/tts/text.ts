/** Text chunking for TTS: whole sentences, grouped up to CHUNK_CHARS. */
export const CHUNK_CHARS = 300;

export function splitSentences(text: string): string[] {
  return text
    .trim()
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** Group whole sentences into chunks of at most maxChars (a longer sentence stays alone). */
export function chunkText(text: string, maxChars = CHUNK_CHARS): string[] {
  const chunks: string[] = [];
  for (const sentence of splitSentences(text)) {
    const last = chunks.at(-1);
    if (last !== undefined && [...last].length + 1 + [...sentence].length <= maxChars) {
      chunks[chunks.length - 1] = `${last} ${sentence}`;
    } else {
      chunks.push(sentence);
    }
  }
  return chunks;
}
