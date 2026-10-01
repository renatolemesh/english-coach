/**
 * The course mode (/aula, /revisar): lessons of short exercises inside WhatsApp.
 *
 * One message per exercise whenever possible: the feedback on the last answer goes on top of
 * the next question (Meta bills every message sent since October 2026). Exercises with audio
 * add a voice note before the question.
 *
 * While a lesson is active, plain text and voice messages are answers. Any other slash command
 * pauses it (the conversation takes over); /aula resumes. A lesson left alone for a while is
 * paused too, so a voice note days later goes to the conversation, not to an old question.
 */
import type { RuntimeConfig } from "../accounts/runtime.js";
import type { Settings } from "../config.js";
import type { StudentAccess } from "../domain/accounts.js";
import { type Choice, option } from "../domain/choices.js";
import { type IncomingMessage, isConfident } from "../domain/messages.js";
import { formatText, PT } from "../domain/texts.js";
import { LEVELS } from "../domain/topics.js";
import { effectiveSpeed, effectiveTutor } from "../domain/tutors.js";
import type { UsageLimits } from "../guardrails/limits.js";
import { getLogger } from "../logging.js";
import { localMidnight } from "../panel/zones.js";
import type { WhatsAppChannel } from "../ports/channel.js";
import type { CourseRepository, Lesson, LessonKind } from "../ports/course.js";
import type { SpeechToText, TextToSpeech } from "../ports/media.js";
import type { CourseContent } from "./content.js";
import {
  AUDIO_TYPES,
  type Exercise,
  type ExerciseType,
  fallbackTypes,
  labelledOptions,
  makeExercise,
  optionLabel,
  pick,
  type Step,
} from "./exercises.js";
import { gradeSpeech, gradeText, type HeardWord, parseChoice } from "./grading.js";
import { PASS, placementBlock, placementLevels, placementNext, START_LEVEL } from "./placement.js";
import { LESSON_SIZE, planLesson } from "./planner.js";
import { type Outcome, review } from "./srs.js";
import { COURSE_PT, type CourseTexts } from "./texts.js";

const log = getLogger("coach.course.engine");
const RENDERING = new Map<string, Promise<Buffer>>(); // audio being rendered, by voice/speed/text

export const START_COMMANDS: ReadonlySet<string> = new Set([
  "aula", "lesson", "licao", "lição", "curso", "course", "exercicios", "exercícios",
]); // biome-ignore format: a word list
export const REVIEW_COMMANDS: ReadonlySet<string> = new Set([
  "revisar",
  "review",
  "revisao",
  "revisão",
]);
export const STOP_COMMANDS: ReadonlySet<string> = new Set([
  "sair",
  "parar",
  "stop",
  "pausar",
  "exit",
]);
export const PLACEMENT_COMMANDS: ReadonlySet<string> = new Set([
  "teste", "test", "nivelamento", "placement",
]); // biome-ignore format: a word list
const ANSWER_COMMAND = "ex"; // button taps: "/ex <nonce><option number>" (0: don't know)
const SKIP_WORDS = /^(n[aã]o sei|pular|pula|skip|i don'?t know|sei l[aá])[.!]?$/i;

export const IDLE_PAUSE_MS = 2 * 3600 * 1000; // an active lesson this quiet is paused
export const RESUME_MS = 24 * 3600 * 1000; // a paused lesson older than this starts over
const MISTAKES_SCAN = 40;
const SENTENCE_REPEAT_DAYS = 14;
const LESSON_BONUS = 5; // points for finishing a lesson (weekly ranking)
const BODY_MAX = 1000; // WhatsApp: 1024 characters in a reply-buttons body

export interface CourseDeps {
  repo: CourseRepository;
  content: CourseContent;
  tts: TextToSpeech;
  stt: SpeechToText;
  settings: Settings;
  limits: UsageLimits;
  now?: () => Date;
  rng?: () => number;
}

export interface CourseTurn {
  msg: IncomingMessage;
  access: StudentAccess;
  channel: WhatsAppChannel;
  config: RuntimeConfig;
}

interface Graded {
  outcome: Outcome;
  correct: boolean;
  score: number | null;
  feedback: string;
  answer: string | null;
}

/** "/aula 2" -> ["aula", "2"]; null for text that is not a command. */
export function slashCommand(text: string): [string, string] | null {
  const m = /^\/+(\S+)\s*(.*)$/s.exec(text.trim());
  return m ? [(m[1] as string).toLowerCase(), (m[2] as string).trim()] : null;
}

/** A mistake from the conversation as a card key (same mistake, same card). */
export function mistakeKey(original: string, correction: string): string {
  const text = `${original}|${correction}`.toLowerCase().replace(/\s+/g, " ").trim();
  let h = 5381;
  for (const ch of text) h = ((h * 33) ^ ch.charCodeAt(0)) >>> 0;
  return `m:${h.toString(36)}`;
}

export class CourseEngine {
  private readonly now: () => Date;
  private readonly rng: () => number;

  constructor(private readonly deps: CourseDeps) {
    this.now = deps.now ?? (() => new Date());
    this.rng = deps.rng ?? Math.random;
  }

  /** True when the message was for the course (and answered here); false: the conversation
   * handles it. */
  async handle(turn: CourseTurn): Promise<boolean> {
    const { msg, access } = turn;
    const text = msg.type === "text" ? (msg.text ?? "").trim() : "";
    const cmd = slashCommand(text);
    const name = cmd?.[0] ?? null;
    const userId = access.user_id;
    if (name && START_COMMANDS.has(name))
      return this.guarded(turn, () => this.start(turn, "lesson"));
    if (name && REVIEW_COMMANDS.has(name))
      return this.guarded(turn, () => this.start(turn, "review"));
    if (name && PLACEMENT_COMMANDS.has(name))
      return this.guarded(turn, () => this.start(turn, "placement"));
    let lesson = await this.deps.repo.openLesson(userId);
    if (
      lesson?.status === "active" &&
      this.now().getTime() - lesson.updatedAt.getTime() > IDLE_PAUSE_MS
    ) {
      lesson = { ...lesson, status: "paused" };
      await this.deps.repo.saveLesson(lesson);
    }
    if (name === ANSWER_COMMAND) {
      return this.guarded(turn, async () => {
        if (lesson?.status !== "active" || !lesson.current) {
          await turn.channel.sendText(msg.from, COURSE_PT.paused);
          return;
        }
        await this.tap(turn, lesson, cmd?.[1] ?? "");
      });
    }
    if (lesson?.status !== "active") return false;
    if (name && STOP_COMMANDS.has(name)) {
      return this.guarded(turn, async () => {
        await this.deps.repo.saveLesson({ ...lesson, status: "paused" });
        await turn.channel.sendText(msg.from, COURSE_PT.paused);
      });
    }
    if (name) {
      await this.deps.repo.saveLesson({ ...lesson, status: "paused" }); // /menu, /tema...
      return false;
    }
    return this.guarded(turn, () => this.reply(turn, lesson, text));
  }

  /** Flood control and errors: a broken lesson must not break the chat. */
  private async guarded(turn: CourseTurn, run: () => Promise<void>): Promise<boolean> {
    const userId = String(turn.access.user_id);
    try {
      if ((await this.deps.limits.checkFree(userId)) !== null) {
        log.info("course_rate_limited");
        return true;
      }
    } catch {
      // Redis down: go on
    }
    try {
      await run();
    } catch (exc) {
      log.exception("course_failed", exc);
      try {
        await turn.channel.sendText(turn.msg.from, COURSE_PT.unavailable);
      } catch {
        // nothing else to do
      }
    }
    return true;
  }

  /** Right after signup: offer the placement test (Pular goes to the usual /start). False when
   * there is no content to test with: the caller runs /start. */
  async offerPlacement(turn: CourseTurn): Promise<boolean> {
    if (this.deps.content.empty) return false;
    const t = COURSE_PT;
    await turn.channel.sendChoice(turn.msg.from, {
      body: t.placementOffer,
      options: [option("teste", t.placementGo), option("start", t.placementSkip)],
      button: "",
      fallbackText: `${t.placementOffer}\n\n/teste · /start`,
    });
    return true;
  }

  // --- starting ----------------------------------------------------------------------------

  private async start(turn: CourseTurn, kind: LessonKind): Promise<void> {
    const { access, channel, msg } = turn;
    const t = COURSE_PT;
    const repo = this.deps.repo;
    const userId = access.user_id;
    if (this.deps.content.empty) {
      await channel.sendText(msg.from, t.unavailable);
      return;
    }
    const open = await repo.openLesson(userId);
    const now = this.now();
    if (open) {
      const recent = now.getTime() - open.updatedAt.getTime() < RESUME_MS;
      if (recent && open.kind === kind && open.current) {
        const lesson = { ...open, status: "active" as const };
        await repo.saveLesson(lesson);
        await this.send(turn, lesson, lesson.current as Exercise, t.resumed);
        return;
      }
      await repo.saveLesson({ ...open, status: "abandoned" });
    }
    if (kind === "placement") {
      const levels = placementLevels(this.deps.content);
      const first = levels.includes(START_LEVEL) ? START_LEVEL : (levels.at(-1) ?? "A1");
      const block = placementBlock(this.deps.content, first, new Set(), this.rng);
      if (!block.length) {
        await channel.sendText(msg.from, t.unavailable);
        return;
      }
      const lesson = await repo.createLesson(userId, kind, block);
      log.info("placement_started", { level: first });
      await this.next(turn, lesson, t.placementIntro);
      return;
    }
    const limit = access.lessons_per_day;
    if (kind === "lesson" && limit !== null && limit !== undefined) {
      const today = await repo.lessonsSince(userId, localMidnight(turn.config.timezone, now));
      if (today >= limit) {
        await channel.sendText(msg.from, formatText(t.dailyLimit, { n: limit }));
        return;
      }
    }
    const lessonsDone = await repo.lessonsDone(userId);
    const known = await repo.knownItems(userId);
    const due = (await repo.dueCards(userId, now, LESSON_SIZE * 3)).map((c) => ({
      item: c.item,
      card: c.card,
      data: c.data,
    }));
    const mistakes = (await repo.conversationMistakes(userId, MISTAKES_SCAN))
      .map((data) => ({ key: mistakeKey(data.original, data.correction), data }))
      .filter((m) => !known.has(m.key) && m.data.original.length <= 80);
    const since = new Date(now.getTime() - SENTENCE_REPEAT_DAYS * 86_400_000);
    const plan = planLesson({
      content: this.deps.content,
      level: access.level || "B1",
      kind,
      due,
      known,
      mistakes,
      usedSentences: await repo.recentSentences(userId, since),
      lessonsDone,
      rng: this.rng,
    });
    if (!plan.length) {
      await channel.sendText(msg.from, kind === "review" ? t.nothingToReview : t.unavailable);
      return;
    }
    const lesson = await repo.createLesson(userId, kind, plan);
    log.info("lesson_started", { kind, steps: plan.length, due: due.length });
    const intro = kind === "lesson" && lessonsDone === 0 ? t.firstLesson : "";
    await this.next(turn, lesson, intro);
  }

  // --- presenting ----------------------------------------------------------------------------

  /** Build the exercise at lesson.position (skipping steps that cannot be built) and send it
   * with `prefix` (the feedback on the last answer) on top. */
  private async next(turn: CourseTurn, lesson: Lesson, prefix: string): Promise<void> {
    let current = lesson;
    while (current.position < current.plan.length) {
      const step = current.plan[current.position] as Step;
      const ex = step.ready ?? this.build(turn, step);
      if (ex) {
        current = { ...current, current: ex };
        const sent = await this.send(turn, current, ex, prefix);
        if (sent) return;
      }
      current = { ...current, position: current.position + 1 }; // could not be shown: skip it
    }
    if (current.kind === "placement") return this.placementStep(turn, current, prefix);
    await this.finish(turn, current, prefix);
  }

  private build(turn: CourseTurn, step: Step): Exercise | null {
    const g = {
      content: this.deps.content,
      level: step.level ?? (turn.access.level || "B1"), // placement: the level being tested
      texts: COURSE_PT,
      rng: this.rng,
    };
    const ex = makeExercise(step, g);
    if (ex) return ex;
    for (const type of fallbackTypes(step.type)) {
      const other = makeExercise({ ...step, type }, g);
      if (other) return other;
    }
    return null;
  }

  private voice(turn: CourseTurn): [string, number] {
    const { access, config } = turn;
    const tutor = effectiveTutor(access.tutor || config.default_tutor, access.tutors);
    const speed = effectiveSpeed(access.speed ?? this.deps.settings.ttsSpeed, access.speeds);
    return [tutor.voice, speed];
  }

  /** Sends the exercise (voice note first when it has audio) and saves it as current.
   * False when its audio could not be made: the caller moves on to another step. */
  private async send(turn: CourseTurn, lesson: Lesson, ex: Exercise, prefix: string) {
    const { channel, msg } = turn;
    const t = COURSE_PT;
    if (ex.audio) {
      try {
        const [voice, speed] = this.voice(turn);
        const ogg = await this.speech(ex.audio, voice, speed);
        await channel.sendVoice(msg.from, ogg);
      } catch (exc) {
        log.warning("course_audio_failed", { type: ex.type, error: String(exc) });
        return false;
      }
    }
    const plan = this.prepareNext(turn, lesson);
    await this.deps.repo.saveLesson({ ...lesson, plan, status: "active", current: ex });
    const headers = {
      lesson: t.lessonHeader,
      review: t.reviewHeader,
      placement: t.placementHeader,
    };
    const header = formatText(headers[lesson.kind], {
      n: lesson.position + 1,
      total: lesson.plan.length,
    });
    await channel.sendChoice(msg.from, this.choice(t, ex, header, prefix));
    return true;
  }

  /** TTS, joining a render already under way for the same audio (prepareNext). */
  private speech(text: string, voice: string, speed: number): Promise<Buffer> {
    const key = `${voice}|${speed}|${text}`;
    const running = RENDERING.get(key);
    if (running) return running;
    const job = this.deps.tts.synthesize(text, voice, speed).finally(() => RENDERING.delete(key));
    RENDERING.set(key, job);
    return job;
  }

  /** Kokoro takes several seconds per sentence on this CPU: when the next exercise has audio,
   * build it now and start rendering, so it is ready (in the TTS cache) when the student
   * answers. Returns the plan with that exercise kept in its step. */
  private prepareNext(turn: CourseTurn, lesson: Lesson): Step[] {
    const at = lesson.position + 1;
    const step = lesson.plan[at];
    if (!step || step.ready || !AUDIO_TYPES.has(step.type)) return lesson.plan;
    const ex = this.build(turn, step);
    if (!ex?.audio) return lesson.plan;
    const [voice, speed] = this.voice(turn);
    this.speech(ex.audio, voice, speed).catch(() => undefined); // failures show up when sent
    return lesson.plan.map((s, i) => (i === at ? { ...s, ready: ex } : s));
  }

  private choice(t: CourseTexts, ex: Exercise, header: string, prefix: string): Choice {
    let question = ex.body;
    if (ex.mode === "choice" && ex.labelled && !question.includes("*A)*")) {
      question = `${question}\n\n${labelledOptions(ex.options)}`;
    }
    let body = [prefix, `${header}\n${question}`].filter(Boolean).join("\n\n");
    if (body.length > BODY_MAX) body = `${header}\n${question}`.slice(0, BODY_MAX);
    const id = (n: number) => `ex:${ex.nonce}${n}`;
    if (ex.mode === "choice") {
      const options = ex.options.map((o, i) => option(id(i + 1), ex.labelled ? optionLabel(i) : o));
      const numbered = ex.options.map((o, i) => `${i + 1}) ${o}`).join("\n");
      return {
        body,
        options,
        button: options.length > 3 ? t.optionsButton : "",
        fallbackText: `${body}\n\n${numbered}`,
      };
    }
    return {
      body,
      options: [option(id(0), t.dontKnow), option("sair", t.stop)],
      button: "",
      fallbackText: `${body}\n\n(${t.dontKnow}: "não sei" · /sair)`,
    };
  }

  // --- answering -----------------------------------------------------------------------------

  /** A button tap: "<nonce><n>", n = 1.. for an option, 0 for "don't know". */
  private async tap(turn: CourseTurn, lesson: Lesson, arg: string): Promise<void> {
    const ex = lesson.current as Exercise;
    const t = COURSE_PT;
    if (arg.slice(0, -1) !== ex.nonce) {
      await turn.channel.sendText(turn.msg.from, t.stale);
      return;
    }
    const n = Number(arg.slice(-1));
    if (n === 0 || ex.mode !== "choice") return this.graded(turn, lesson, this.skip(t, ex));
    if (n > ex.options.length) return;
    return this.graded(turn, lesson, this.gradeChoice(t, ex, n - 1));
  }

  /** A typed or spoken answer. */
  private async reply(turn: CourseTurn, lesson: Lesson, text: string): Promise<void> {
    const { msg, channel } = turn;
    const t = COURSE_PT;
    const ex = lesson.current;
    if (!ex) return this.next(turn, lesson, "");
    if (text && SKIP_WORDS.test(text)) return this.graded(turn, lesson, this.skip(t, ex));
    if (ex.mode === "voice") {
      if (msg.type !== "audio" || !msg.media_ref) {
        await channel.sendText(msg.from, t.voiceHint);
        return;
      }
      const graded = await this.gradeVoice(turn, ex);
      if (graded) return this.graded(turn, lesson, graded);
      await channel.sendText(msg.from, t.spokenRetry); // not graded: try again
      return;
    }
    if (msg.type !== "text" || !text) {
      const hint =
        ex.mode === "text" ? t.typeHint : formatText(t.chooseHint, { n: ex.options.length });
      await channel.sendText(msg.from, hint);
      return;
    }
    if (ex.mode === "choice") {
      const index = parseChoice(text, ex.options);
      if (index === null) {
        await channel.sendText(msg.from, formatText(t.chooseHint, { n: ex.options.length }));
        return;
      }
      return this.graded(turn, lesson, this.gradeChoice(t, ex, index));
    }
    return this.graded(turn, lesson, this.gradeTyped(t, ex, text));
  }

  private withTip(line: string, ex: Exercise, always: boolean): string {
    return ex.tip && always ? `${line}\n${ex.tip}` : line;
  }

  private gradeChoice(t: CourseTexts, ex: Exercise, index: number): Graded {
    const right = index === ex.answer;
    const reveal = ex.reveal || (ex.options[ex.answer] ?? "");
    const lesson = ["fix", "false_friend", "pair", "chat", "mistake"].includes(ex.type);
    const feedback = right
      ? this.withTip(
          `${pick(t.right, this.rng)} ${ex.type === "fix" ? "" : reveal}`.trim(),
          ex,
          lesson,
        )
      : this.withTip(formatText(t.wrong, { answer: reveal }), ex, true);
    return {
      outcome: right ? "good" : "again",
      correct: right,
      score: null,
      feedback,
      answer: ex.options[index] ?? null,
    };
  }

  private gradeTyped(t: CourseTexts, ex: Exercise, text: string): Graded {
    let answer = text;
    if (ex.type === "order" && /^[\d\s,.-]+$/.test(text)) {
      // "3 1 2": the numbers of the tiles in order
      const picked = text.match(/\d/g)?.map((d) => ex.tiles[Number(d) - 1]) ?? [];
      answer = picked.every(Boolean) ? picked.join(" ") : text;
    }
    const grade = gradeText(answer, ex.accept);
    const pass = ex.type === "dictation" ? grade.score >= 85 : grade.ok;
    if (pass) {
      const line = grade.typos.length
        ? formatText(t.almost, { words: grade.typos.join(", ") })
        : `${pick(t.right, this.rng)} ${ex.type === "type" ? `*${ex.reveal}*` : ""}`.trim();
      return {
        outcome: grade.typos.length ? "hard" : "good",
        correct: true,
        score: grade.score,
        feedback: this.withTip(line, ex, ex.type === "dictation"),
        answer: text,
      };
    }
    return {
      outcome: "again",
      correct: false,
      score: grade.score,
      feedback: this.withTip(formatText(t.wrong, { answer: grade.best || ex.reveal }), ex, true),
      answer: text,
    };
  }

  private async gradeVoice(turn: CourseTurn, ex: Exercise): Promise<Graded | null> {
    const { msg, channel } = turn;
    const s = this.deps.settings;
    if (msg.media_size && msg.media_size > s.maxAudioBytes) return null;
    const [audio, mime] = await channel.downloadMedia(msg.media_ref as string);
    const heard = await this.deps.stt.transcribe(audio, mime);
    if (!heard.text.trim() || !isConfident(heard, s.sttMinConfidence)) return null;
    const words: HeardWord[] = heard.words?.length ? heard.words : [{ text: heard.text, p: 1 }];
    const grade = gradeSpeech(words, ex.accept);
    const t = COURSE_PT;
    const pass = ex.type === "say" ? 70 : 80;
    const outcome: Outcome = grade.score >= pass ? "good" : grade.score >= 60 ? "hard" : "again";
    let feedback = formatText(t.spoken, { score: grade.score, heard: heard.text.trim() });
    if (grade.weak.length) {
      feedback += `\n${formatText(t.spokenWeak, { words: grade.weak.slice(0, 3).join(", ") })}`;
    }
    if (outcome === "again" || ex.type === "say") feedback += `\n👉 *${grade.best || ex.reveal}*`;
    return {
      outcome,
      correct: outcome !== "again",
      score: grade.score,
      feedback,
      answer: heard.text,
    };
  }

  private skip(t: CourseTexts, ex: Exercise): Graded {
    const reveal = ex.reveal || (ex.options[ex.answer] ?? "");
    return {
      outcome: "again",
      correct: false,
      score: null,
      feedback: this.withTip(formatText(t.skipped, { answer: reveal }), ex, true),
      answer: null,
    };
  }

  /** Record the answer, move the card, and go on to the next exercise. */
  private async graded(turn: CourseTurn, lesson: Lesson, g: Graded): Promise<void> {
    const ex = lesson.current as Exercise;
    const repo = this.deps.repo;
    const userId = turn.access.user_id;
    const step = lesson.plan[lesson.position];
    if (ex.item && lesson.kind !== "placement") {
      const row = await repo.card(userId, ex.item);
      await repo.saveCard(userId, {
        item: ex.item,
        card: review(row?.card ?? null, g.outcome, this.now()),
        data: step?.data ?? row?.data ?? null,
      });
    }
    await repo.recordAttempt({
      lessonId: lesson.id,
      studentId: userId,
      item: ex.item ?? `s:${ex.sentence ?? ""}`,
      type: ex.type,
      correct: g.correct,
      score: g.score,
      answer: g.answer,
    });
    log.info("exercise_answered", { type: ex.type, correct: g.correct, score: g.score });
    const moved: Lesson = {
      ...lesson,
      // placement: each answer decides the next block
      plan: lesson.plan.map((s, i) => (i === lesson.position ? { ...s, ok: g.correct } : s)),
      current: null,
      position: lesson.position + 1,
      answered: lesson.answered + 1,
      correct: lesson.correct + (g.correct ? 1 : 0),
    };
    await this.next(turn, moved, g.feedback);
  }

  /** Placement test, after each block: test another level, or give the result. */
  private async placementStep(turn: CourseTurn, lesson: Lesson, prefix: string): Promise<void> {
    const levels = placementLevels(this.deps.content);
    const results = lesson.plan
      .filter((s) => s.level && s.ok !== undefined)
      .map((s) => ({ level: s.level as string, ok: s.ok as boolean }));
    const decision = placementNext(results, levels);
    if ("next" in decision) {
      const used = new Set(lesson.plan.map((s) => s.item ?? ""));
      const block = placementBlock(this.deps.content, decision.next, used, this.rng);
      if (block.length)
        return this.next(turn, { ...lesson, plan: [...lesson.plan, ...block] }, prefix);
    }
    // the result, or (content ran out) the highest level passed so far
    const passed = levels.filter((lv) => {
      const mine = results.filter((r) => r.level === lv);
      return mine.length && mine.filter((r) => r.ok).length >= Math.min(PASS, mine.length);
    });
    const level = "result" in decision ? decision.result : (passed.at(-1) ?? levels[0] ?? "A1");
    await this.finishPlacement(turn, lesson, prefix, level, results, levels);
  }

  private async finishPlacement(
    turn: CourseTurn,
    lesson: Lesson,
    prefix: string,
    level: string,
    results: readonly { level: string; ok: boolean }[],
    levels: readonly string[],
  ): Promise<void> {
    const t = COURSE_PT;
    const { access } = turn;
    await this.deps.repo.saveLesson({ ...lesson, status: "done", current: null, points: 0 });
    await this.deps.repo.saveLevel(access.user_id, level);
    const blocks = levels
      .map((lv) => {
        const mine = results.filter((r) => r.level === lv);
        if (!mine.length) return "";
        const right = mine.filter((r) => r.ok).length;
        const pass = right >= Math.min(PASS, mine.length);
        return `${lv} ${pass ? "✅" : "❌"} ${right}/${mine.length}`;
      })
      .filter(Boolean)
      .join(" · ");
    const nextLevel = LEVELS[(LEVELS as readonly string[]).indexOf(level) + 1];
    const top =
      level === levels.at(-1) && nextLevel ? formatText(t.placementTop, { next: nextLevel }) : "";
    const result = formatText(t.placementResult, {
      level,
      name: (PT.levelNames[level] ?? level).split(":")[0] ?? level, // "Básico: ..." -> "Básico"
      blocks,
    });
    log.info("placement_done", { level, answered: results.length });
    const body = [prefix, result, top].filter(Boolean).join("\n\n");
    // a student who never talked gets the first-meeting welcome; the others, a new question
    const talk = access.topic ? "resume" : "start";
    await turn.channel.sendChoice(turn.msg.from, {
      body,
      options: [
        option(talk, t.placementTalk),
        option("aula", t.placementLesson),
        option("menu", t.menu),
      ],
      button: "",
      fallbackText: `${body}\n\n/${talk} · /aula · /menu`,
    });
  }

  private async finish(turn: CourseTurn, lesson: Lesson, prefix: string): Promise<void> {
    const t = COURSE_PT;
    const repo = this.deps.repo;
    const points = lesson.correct + (lesson.kind === "lesson" ? LESSON_BONUS : 0);
    await repo.saveLesson({ ...lesson, status: "done", current: null, points });
    const stats = await repo.stats(turn.access.user_id, this.now());
    const fresh = lesson.plan
      .filter((s) => s.fresh && s.item?.startsWith("w:"))
      .map((s) => this.deps.content.words.get((s.item as string).slice(2))?.word)
      .filter(Boolean);
    const lines = [
      formatText(t.finished, { correct: lesson.correct, total: lesson.answered, points }),
      fresh.length ? formatText(t.finishedNew, { words: fresh.join(", ") }) : "",
      stats.due ? formatText(t.finishedDue, { n: stats.due }) : "",
    ].filter(Boolean);
    log.info("lesson_done", { kind: lesson.kind, correct: lesson.correct, total: lesson.answered });
    const options = [option("aula", t.again)];
    if (stats.due) options.push(option("revisar", t.review));
    options.push(option("menu", t.menu));
    const body = [prefix, lines.join("\n")].filter(Boolean).join("\n\n");
    await turn.channel.sendChoice(turn.msg.from, {
      body,
      options,
      button: "",
      fallbackText: `${body}\n\n/aula · /revisar · /menu`,
    });
  }
}

export type { ExerciseType };
