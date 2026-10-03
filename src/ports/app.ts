/** The app's side of the database: sessions, the events the bot "sent" and media. */

export const APP_EVENT_KINDS = ["text", "voice", "image", "choice", "evaluation"] as const;
export type AppEventKind = (typeof APP_EVENT_KINDS)[number];

export interface AppEvent {
  id: number;
  kind: AppEventKind;
  text: string | null;
  data: unknown; // choice: {options, button}; evaluation: the Evaluation
  mediaId: string | null;
  createdAt: Date;
}

export interface AppMedia {
  studentId: number;
  mime: string;
  data: Buffer;
}

export interface AppStore {
  addEvent(studentId: number, event: Omit<AppEvent, "id" | "createdAt">): Promise<number>;
  /** The last `limit` events, oldest first. */
  recentEvents(studentId: number, limit: number): Promise<AppEvent[]>;
  /** Events after `afterId`, oldest first. */
  events(studentId: number, afterId: number, limit: number): Promise<AppEvent[]>;
  putMedia(studentId: number, data: Buffer, mime: string): Promise<string>;
  media(id: string): Promise<AppMedia | null>;
  /** Media older than `before` (replies already heard, uploads already transcribed). */
  purgeMedia(before: Date): Promise<number>;
  /** A new session: the raw token (only its hash is kept). */
  createToken(studentId: number): Promise<string>;
  tokenStudent(token: string): Promise<number | null>;
  revokeToken(token: string): Promise<void>;
}
