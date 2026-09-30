/**
 * Spaced repetition with FSRS (ts-fsrs): each course item has a card; an answer moves its next
 * review. Target retention 90%: reviews come when the student is about to forget.
 */
import {
  type Card,
  createEmptyCard,
  fsrs,
  type Grade,
  generatorParameters,
  Rating,
  State,
} from "ts-fsrs";

export type Outcome = "good" | "hard" | "again";

const scheduler = fsrs(
  generatorParameters({ request_retention: 0.9, maximum_interval: 365, enable_fuzz: true }),
);

const GRADES: Record<Outcome, Grade> = {
  good: Rating.Good,
  hard: Rating.Hard,
  again: Rating.Again,
};

export function review(card: Card | null, outcome: Outcome, now = new Date()): Card {
  return scheduler.next(card ?? createEmptyCard(now), now, GRADES[outcome]).card;
}

/** Cards are stored as JSON (course_cards.fsrs); dates come back as strings. */
export function cardFromJson(raw: Record<string, unknown>): Card {
  const date = (v: unknown) => (v ? new Date(String(v)) : undefined);
  return {
    ...(raw as unknown as Card),
    due: date(raw.due) ?? new Date(),
    last_review: date(raw.last_review),
  };
}

export const cardToJson = (card: Card): Record<string, unknown> => ({
  ...card,
  due: card.due.toISOString(),
  last_review: card.last_review?.toISOString(),
});

export const relearning = (card: Card) => card.state === State.Relearning;
