/** Headings of the RAG context (evaluate checks for MEMORY_SECTION). */
export type Collection = "lesson_content" | "grammar_notes" | "student_mistakes";
export const MEMORY_SECTION = "This student's previous mistakes";
export const SECTIONS: readonly (readonly [Collection, string])[] = [
  ["lesson_content", "Useful language for this topic"],
  ["grammar_notes", "Grammar notes for Brazilian learners"],
  ["student_mistakes", MEMORY_SECTION],
];
