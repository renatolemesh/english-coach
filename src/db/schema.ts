/**
 * Drizzle schema of the existing database (created before Drizzle; its alembic_version table
 * stays but is not managed here). Field names in TS are camelCase; columns keep their
 * snake_case names. Defaults applied on insert by the app, not by the database, are
 * `$defaultFn` so the schema matches the database exactly.
 */
import { sql } from "drizzle-orm";
import {
  boolean,
  customType,
  doublePrecision,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  serial,
  text,
  timestamp,
  unique,
  varchar,
  vector,
} from "drizzle-orm/pg-core";

const tsvector = customType<{ data: string }>({ dataType: () => "tsvector" });
const tz = (name: string) => timestamp(name, { withTimezone: true, mode: "date" });

export const webhookEvents = pgTable(
  "webhook_events",
  {
    id: serial().primaryKey(),
    connectionId: varchar("connection_id", { length: 64 }).notNull(),
    messageId: varchar("message_id", { length: 128 }),
    payload: jsonb().notNull(),
    status: varchar({ length: 16 }).notNull().default("received"),
    error: text(),
    receivedAt: tz("received_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_webhook_events_connection_id").on(t.connectionId),
    index("ix_webhook_events_message_id").on(t.messageId),
  ],
);

export const plans = pgTable(
  "plans",
  {
    id: serial().primaryKey(),
    name: varchar({ length: 60 }).notNull(),
    description: text().notNull().default(""),
    messagesPerDay: integer("messages_per_day"),
    durationDays: integer("duration_days"),
    isActive: boolean("is_active").notNull().default(true),
    createdAt: tz("created_at").defaultNow().notNull(),
    tutors: text().array(), // tutor ids the plan offers; null: all
    speeds: doublePrecision().array(), // TTS speeds the plan offers; null: all
    nextPlanId: integer("next_plan_id"), // where the student goes when the plan ends
    lessonsPerDay: integer("lessons_per_day"), // course lessons a day (/aula); null: unlimited
  },
  (t) => [
    unique("plans_name_key").on(t.name),
    foreignKey({
      columns: [t.nextPlanId],
      foreignColumns: [t.id],
      name: "plans_next_plan_id_fkey",
    }).onDelete("set null"),
  ],
);

export const students = pgTable(
  "students",
  {
    id: serial().primaryKey(),
    connectionId: varchar("connection_id", { length: 64 }).notNull(),
    phone: varchar({ length: 32 }).notNull(),
    topic: varchar({ length: 120 }),
    level: varchar({ length: 8 }).notNull().default("B1"),
    createdAt: tz("created_at").defaultNow().notNull(),
    name: varchar({ length: 120 }),
    status: varchar({ length: 16 }).notNull().default("active"),
    planId: integer("plan_id"),
    planStartedAt: tz("plan_started_at"),
    planEndsAt: tz("plan_ends_at"),
    passwordHash: varchar("password_hash", { length: 255 }),
    verifiedAt: tz("verified_at"),
    notes: text().notNull().default(""),
    uiLang: varchar("ui_lang", { length: 4 }),
    tutor: varchar({ length: 16 }),
    speed: doublePrecision(),
    lastMessageAt: tz("last_message_at"),
    dailyGoal: integer("daily_goal").notNull().default(5), // practices a day (panel, /meta)
    inRanking: boolean("in_ranking").notNull().default(true),
    reminders: boolean().notNull().default(true), // a nudge before the 24 h window closes
    remindedAt: tz("reminded_at"),
    // where the last message came from (reminders go there): a student_identities pair
    lastConnectionId: varchar("last_connection_id", { length: 64 }),
    lastAddress: varchar("last_address", { length: 64 }),
  },
  (t) => [
    index("ix_students_connection_id").on(t.connectionId),
    foreignKey({
      columns: [t.planId],
      foreignColumns: [plans.id],
      name: "students_plan_id_fkey",
    }).onDelete("set null"),
    unique("students_connection_id_phone_key").on(t.connectionId, t.phone),
  ],
);

/** Where a student talks to the bot: (connection, address) -> student. The address is the phone
 * on WhatsApp, the chat id on Telegram, the student id in the app. One student, many channels. */
export const studentIdentities = pgTable(
  "student_identities",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    connectionId: varchar("connection_id", { length: 64 }).notNull(),
    address: varchar({ length: 64 }).notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    unique("student_identities_connection_address_key").on(t.connectionId, t.address),
    index("ix_student_identities_student_id").on(t.studentId),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "student_identities_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const turns = pgTable(
  "turns",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    kind: varchar({ length: 16 }).notNull(),
    topic: varchar({ length: 120 }).notNull(),
    level: varchar({ length: 8 }).notNull(),
    transcript: text(),
    evaluation: jsonb(),
    score: integer(),
    replyText: text("reply_text"),
    blockedReason: varchar("blocked_reason", { length: 32 }),
    costUsd: doublePrecision("cost_usd")
      .notNull()
      .$defaultFn(() => 0),
    inputTokens: integer("input_tokens")
      .notNull()
      .$defaultFn(() => 0),
    outputTokens: integer("output_tokens")
      .notNull()
      .$defaultFn(() => 0),
    latencyMs: doublePrecision("latency_ms")
      .notNull()
      .$defaultFn(() => 0),
    errors: jsonb().$type<string[]>(),
    createdAt: tz("created_at").defaultNow().notNull(),
    notes: jsonb().$type<string[]>(),
  },
  (t) => [
    index("ix_turns_student_id").on(t.studentId),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "turns_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const mistakes = pgTable(
  "mistakes",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    turnId: integer("turn_id").notNull(),
    original: text().notNull(),
    correction: text().notNull(),
    type: varchar({ length: 16 }).notNull(),
    explanation: text().notNull(),
    topic: varchar({ length: 120 }).notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_mistakes_student_id").on(t.studentId),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "mistakes_student_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.turnId],
      foreignColumns: [turns.id],
      name: "mistakes_turn_id_fkey",
    }).onDelete("cascade"),
  ],
);

export const channelConnections = pgTable("channel_connections", {
  id: varchar({ length: 64 }).primaryKey(),
  name: varchar({ length: 120 }).notNull(),
  provider: varchar({ length: 16 }).notNull(),
  enabled: boolean().notNull(),
  credentials: text().notNull(), // Fernet token of a JSON object
  webhookSecret: text("webhook_secret").notNull(), // Fernet token
  settings: jsonb().$type<Record<string, unknown>>().notNull(),
  createdAt: tz("created_at").defaultNow().notNull(),
  updatedAt: tz("updated_at").defaultNow().notNull(),
});

export const documents = pgTable(
  "documents",
  {
    id: serial().primaryKey(),
    collection: varchar({ length: 32 }).notNull(),
    contentHash: varchar("content_hash", { length: 64 }).notNull(),
    key: varchar({ length: 120 }),
    source: varchar({ length: 200 }),
    content: text().notNull(),
    topic: varchar({ length: 120 }),
    level: varchar({ length: 8 }),
    kind: varchar({ length: 32 }).notNull(),
    userId: integer("user_id"),
    metadata: jsonb().$type<Record<string, unknown>>().notNull(),
    embedding: vector({ dimensions: 384 }).notNull(),
    tsv: tsvector("tsv")
      .notNull()
      .generatedAlwaysAs(sql`to_tsvector('english'::regconfig, content)`),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_documents_embedding_hnsw").using("hnsw", t.embedding.op("vector_cosine_ops")),
    index("ix_documents_filters").on(t.collection, t.topic, t.level),
    index("ix_documents_tsv").using("gin", t.tsv),
    index("ix_documents_user").on(t.userId).where(sql`(user_id IS NOT NULL)`),
    foreignKey({
      columns: [t.userId],
      foreignColumns: [students.id],
      name: "documents_user_id_fkey",
    }).onDelete("cascade"),
    unique("documents_content_hash_key").on(t.contentHash),
  ],
);

export const adminUsers = pgTable(
  "admin_users",
  {
    id: serial().primaryKey(),
    email: varchar({ length: 200 }).notNull(),
    name: varchar({ length: 120 }).notNull(),
    passwordHash: varchar("password_hash", { length: 255 }).notNull(),
    role: varchar({ length: 16 }).notNull().default("staff"),
    isActive: boolean("is_active").notNull().default(true),
    mustChangePassword: boolean("must_change_password").notNull().default(false),
    lastLoginAt: tz("last_login_at"),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [unique("admin_users_email_key").on(t.email)],
);

export const webSessions = pgTable(
  "web_sessions",
  {
    id: varchar({ length: 64 }).primaryKey(), // SHA-256 of the cookie token
    kind: varchar({ length: 8 }).notNull(),
    subjectId: integer("subject_id").notNull(),
    csrf: varchar({ length: 64 }).notNull(),
    ip: varchar({ length: 64 }).notNull().default(""),
    userAgent: varchar("user_agent", { length: 200 }).notNull().default(""),
    createdAt: tz("created_at").defaultNow().notNull(),
    lastSeenAt: tz("last_seen_at").defaultNow().notNull(),
    expiresAt: tz("expires_at").notNull(),
  },
  (t) => [index("ix_web_sessions_subject").on(t.kind, t.subjectId)],
);

export const appSettings = pgTable("app_settings", {
  key: varchar({ length: 64 }).primaryKey(),
  value: jsonb().notNull(),
  updatedBy: varchar("updated_by", { length: 200 }).notNull().default(""),
  updatedAt: tz("updated_at").defaultNow().notNull(),
});

export const auditLog = pgTable(
  "audit_log",
  {
    id: serial().primaryKey(),
    actor: varchar({ length: 200 }).notNull(),
    action: varchar({ length: 64 }).notNull(),
    target: varchar({ length: 200 }).notNull().default(""),
    details: jsonb().$type<Record<string, unknown>>(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [index("ix_audit_log_created_at").on(t.createdAt)],
);

/** Spaced-repetition card of one course item per student (ts-fsrs Card in `fsrs`). Items:
 * "w:<word id>", "g:<grammar trap>", "ff:<false friend>", "mp:<minimal pair>", "c:<chat>",
 * "m:<hash>" (a mistake from the conversation; its content is in `data`). */
export const courseCards = pgTable(
  "course_cards",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    item: varchar({ length: 160 }).notNull(),
    due: tz("due").notNull(),
    fsrs: jsonb().$type<Record<string, unknown>>().notNull(),
    data: jsonb().$type<Record<string, unknown>>(),
    createdAt: tz("created_at").defaultNow().notNull(),
    updatedAt: tz("updated_at").defaultNow().notNull(),
  },
  (t) => [
    unique("course_cards_student_item_key").on(t.studentId, t.item),
    index("ix_course_cards_due").on(t.studentId, t.due),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "course_cards_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

/** A lesson (/aula) or review (/revisar): the planned steps and the exercise waiting for an
 * answer. status: active | paused | done | abandoned. */
export const courseLessons = pgTable(
  "course_lessons",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    kind: varchar({ length: 12 }).notNull(),
    status: varchar({ length: 12 }).notNull(),
    plan: jsonb().$type<unknown[]>().notNull(),
    position: integer().notNull().default(0),
    current: jsonb().$type<Record<string, unknown>>(),
    correct: integer().notNull().default(0),
    answered: integer().notNull().default(0),
    points: integer().notNull().default(0),
    startedAt: tz("started_at").defaultNow().notNull(),
    updatedAt: tz("updated_at").defaultNow().notNull(),
    finishedAt: tz("finished_at"),
  },
  (t) => [
    index("ix_course_lessons_student").on(t.studentId, t.startedAt),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "course_lessons_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

/** Every answered exercise (stats, weekly points, sentences not to repeat soon). */
export const courseAttempts = pgTable(
  "course_attempts",
  {
    id: serial().primaryKey(),
    lessonId: integer("lesson_id").notNull(),
    studentId: integer("student_id").notNull(),
    item: varchar({ length: 160 }).notNull(), // card item, or "s:<sentence id>"
    type: varchar({ length: 16 }).notNull(),
    correct: boolean().notNull(),
    score: integer(), // 0-100 for dictation and speaking
    answer: text(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_course_attempts_student").on(t.studentId, t.createdAt),
    foreignKey({
      columns: [t.lessonId],
      foreignColumns: [courseLessons.id],
      name: "course_attempts_lesson_id_fkey",
    }).onDelete("cascade"),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "course_attempts_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

// --- the app (src/api/app-api.ts, adapters/channels/app.ts) -----------------------------------

const bytea = customType<{ data: Buffer }>({ dataType: () => "bytea" });

/** Logged-in app sessions: only the token's sha256 is stored. */
export const appTokens = pgTable(
  "app_tokens",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    tokenHash: varchar("token_hash", { length: 64 }).notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
    lastUsedAt: tz("last_used_at").defaultNow().notNull(),
  },
  (t) => [
    unique("app_tokens_token_hash_key").on(t.tokenHash),
    index("ix_app_tokens_student_id").on(t.studentId),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "app_tokens_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

/** What the bot "sent" to the app: the app fetches them (GET /app/v1/events). */
export const appEvents = pgTable(
  "app_events",
  {
    id: serial().primaryKey(),
    studentId: integer("student_id").notNull(),
    kind: varchar({ length: 16 }).notNull(), // text | voice | image | choice | evaluation
    text: text(),
    data: jsonb(), // choice: {options, button}; evaluation: the evaluation
    mediaId: varchar("media_id", { length: 40 }),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_app_events_student_id").on(t.studentId, t.id),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "app_events_student_id_fkey",
    }).onDelete("cascade"),
  ],
);

/** Audio and images of the app, both ways (the tutor's voice, the student's recordings). */
export const appMedia = pgTable(
  "app_media",
  {
    id: varchar({ length: 40 }).primaryKey(),
    studentId: integer("student_id").notNull(),
    mime: varchar({ length: 80 }).notNull(),
    data: bytea().notNull(),
    createdAt: tz("created_at").defaultNow().notNull(),
  },
  (t) => [
    index("ix_app_media_created_at").on(t.createdAt),
    foreignKey({
      columns: [t.studentId],
      foreignColumns: [students.id],
      name: "app_media_student_id_fkey",
    }).onDelete("cascade"),
  ],
);
