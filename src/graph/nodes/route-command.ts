/**
 * Slash commands (/tema, /nivel, /voz, /velocidade, /idioma, /ajuda, /reset) and first
 * contact. No evaluation LLM call; /tema, /reset and first contact generate a spoken opener
 * with `topic_opener`; /voz and /velocidade replay the last reply in the new voice (no LLM).
 * Fixed texts and menus come in the student's language (domain/texts.ts).
 */
import {
  languageMenu,
  levelMenu,
  mainMenu,
  speedMenu,
  topicMenu,
  tutorMenu,
} from "../../domain/choices.js";
import { canonical } from "../../domain/commands.js";
import { pickOpener } from "../../domain/openers.js";
import {
  GOOD_SCORE,
  goalAboveLimit,
  goalOf,
  LEVEL_UP,
  MAX_DAILY_GOAL,
  nextLevel,
  parseGoal,
} from "../../domain/progress.js";
import { OPENER_FALLBACK, Reply } from "../../domain/reply.js";
import { formatText, parseLang, textsFor } from "../../domain/texts.js";
import { cleanTopic, DEFAULT_TOPIC, LEVELS, parseLevel } from "../../domain/topics.js";
import {
  parseSpeed,
  parseTutor,
  SAMPLE_LINE,
  SPEEDS,
  speedOffered,
  TUTORS,
  tutorOffered,
} from "../../domain/tutors.js";
import { checkText } from "../../guardrails/input-rules.js";
import { getLogger } from "../../logging.js";
import { localMidnight } from "../../panel/zones.js";
import { levelOf, meta, speedIn, textsOf, topicOf, tutorIn } from "../common.js";
import { ctxOf, type GraphContext, type NodeConfig } from "../context.js";
import type { ConversationState, Update } from "../state.js";
import { translate } from "./translate.js";

const log = getLogger("coach.graph.nodes.route_command");
export const RECENT_OPENERS = 3; // not asked again soon (e.g. the question before an idle reset)
// Placed outside the delimiter tags of topic_opener: only these constants, never user text.
export const SITUATIONS = {
  first_meeting: "first meeting",
  new_topic: "the chat goes on with a new topic: no hello, no 'again', no introduction",
  returning: "the student is back after a break: a short 'welcome back', no introduction",
} as const;
type Situation = keyof typeof SITUATIONS;

export async function routeCommand(state: ConversationState, config: NodeConfig): Promise<Update> {
  const ctx = ctxOf(config);
  const command = canonical(state.command || "");
  const arg = state.command_arg || "";
  const levels = LEVELS.join(", ");
  const t = textsOf(state);

  if (command === "transcribe" || command === "translate") {
    return lastReply(state, ctx, command === "translate");
  }
  if (command === "menu") {
    let menu = mainMenu(t);
    const limit = state.daily_limit;
    if (limit !== null && limit !== undefined) {
      // "12 messages left today."
      const used = await ctx.limits.usedToday(String(state.user_id), ctx.config.timezone);
      const left = formatText(t.messagesLeft, { n: Math.max(limit - used, 0) });
      menu = { ...menu, body: `${menu.body}\n${left}` };
    }
    return { outbound_choices: [menu] };
  }
  if (command === "resume") {
    // back after session_idle_hours (runtime config): same topic, new question
    const current = topicOf(state);
    const opener = await makeOpener(state, ctx, current, "returning");
    return { ...opener, outbound_texts: [formatText(t.welcomeBack, { topic: current })] };
  }
  if (command === "help") return { outbound_texts: [t.help] };
  if (command === "language") {
    const lang = parseLang(arg);
    if (lang === null) return { outbound_choices: [languageMenu(t)] };
    return { ui_lang: lang, outbound_texts: [textsFor(lang).languageSet] };
  }
  if (command === "voice") {
    const tutor = parseTutor(arg);
    const offered = state.offered_tutors;
    if (tutor === null) return { outbound_choices: [tutorMenu(t, tutorIn(state), offered)] };
    if (!tutorOffered(tutor.id, offered)) {
      const names = Object.values(TUTORS).filter((x) => tutorOffered(x.id, offered));
      const text = formatText(t.tutorLocked, {
        tutor: tutor.name,
        offered: names.map((x) => x.name).join(", "),
      });
      return { outbound_texts: [text] };
    }
    const text = formatText(t.tutorSet, {
      tutor: t.tutorCalled(tutor.name, tutor.gender),
      description: t.tutorDescription(tutor.accent, tutor.gender),
    });
    return { tutor: tutor.id, ...sample(state, tutor.name), outbound_texts: [text] };
  }
  if (command === "speed") {
    const speed = parseSpeed(arg);
    const offered = state.offered_speeds;
    if (speed === null)
      return { outbound_choices: [speedMenu(t, speedIn(state, ctx.settings.ttsSpeed), offered)] };
    if (!speedOffered(speed, offered)) {
      const labels = [...SPEEDS.values()].filter((v) => speedOffered(v, offered));
      const text = formatText(t.speedLocked, {
        speed: t.speedLabel(speed),
        offered: labels.map((v) => t.speedLabel(v)).join(", "),
      });
      return { outbound_texts: [text] };
    }
    const key = [...SPEEDS].find(([, v]) => v === speed)?.[0] ?? "";
    const name = (t.speedNames[key] ?? "").toLowerCase();
    const text = formatText(t.speedSet, { speed: t.speedLabel(speed), name });
    return { speed, ...sample(state, tutorIn(state).name), outbound_texts: [text] };
  }
  if (command === "goal") {
    const goal = arg ? parseGoal(arg) : null;
    if (goal !== null && goalAboveLimit(goal, state.daily_limit)) {
      return { outbound_texts: [formatText(t.goalTooHigh, { limit: state.daily_limit })] };
    }
    if (goal !== null)
      return { daily_goal: goal, outbound_texts: [formatText(t.goalSet, { goal })] };
    return { outbound_texts: [await goalStatus(state, ctx)] };
  }
  if (command === "level") {
    if (!arg) {
      const show = formatText(t.levelShow, { level: levelOf(state), levels });
      return { outbound_choices: [levelMenu(t, levelOf(state), show)] };
    }
    const level = parseLevel(arg);
    if (level === null) return { outbound_texts: [formatText(t.levelInvalid, { levels })] };
    return { level, outbound_texts: [formatText(t.levelSet, { level })] };
  }
  if (command === "topic") {
    const menu = topicMenu(t, topicOf(state));
    const topic = arg ? cleanTopic(arg) : null;
    if (topic === null) return { outbound_choices: [menu] };
    if (checkText(topic, ctx.settings) !== null) {
      log.info("topic_rejected", { reason: "rules" }); // same rules as messages
      return { outbound_choices: [menu] };
    }
    const opener = await makeOpener(state, ctx, topic, "new_topic");
    return {
      ...opener,
      topic,
      recent_turns: [], // new topic, fresh short-term memory (summary keeps facts)
      outbound_texts: [formatText(t.topicSet, { topic })],
    };
  }
  if (command === "start" || command === "reset") {
    const tutor = tutorIn(state);
    const welcome = formatText(t.welcome, { tutor: t.tutorCalled(tutor.name, tutor.gender) });
    const first = command === "start" ? welcome : `${t.resetDone}\n\n${welcome}`;
    const topic = DEFAULT_TOPIC;
    const opener = await makeOpener(state, ctx, topic, "first_meeting");
    return {
      ...opener,
      topic,
      level: levelOf(state),
      history_summary: "",
      recent_turns: [],
      outbound_texts: [first, formatText(t.topicSet, { topic })],
    };
  }
  return { outbound_texts: [t.unknownCommand] };
}

async function makeOpener(
  state: ConversationState,
  ctx: GraphContext,
  topic: string,
  situation: Situation,
): Promise<Update> {
  const level = levelOf(state);
  const used = [...(state.used_openers ?? [])];
  const idea = pickOpener(ctx.settings.dataDir, topic, { avoid: used }); // variety + topic fallback
  let context = "(none)";
  try {
    context = await ctx.retriever.retrieve(topic, topic, level, state.user_id);
  } catch {
    // an opener works without context
  }
  const result = await ctx.llm.structured(
    "topic_opener",
    {
      topic,
      level,
      situation: SITUATIONS[situation],
      tutor: tutorIn(state).persona,
      idea: idea ?? "(none)",
      retrieved_context: context,
    },
    Reply,
    { text: idea ?? OPENER_FALLBACK },
    meta(state),
  );
  const update: Update = {
    used_openers: (idea ? [...used, idea] : used).slice(-RECENT_OPENERS),
    reply_text: result.value.text,
    retrieved_context: context, // guard_output checks the opener does not quote it
    usage: [result.usage],
  };
  if (result.fallbackUsed) update.errors = [`topic_opener:${result.fallbackReason}`];
  return update;
}

/** The last reply again, so the student hears the new voice or speed right away. */
function sample(state: ConversationState, name: string): Update {
  return { reply_text: state.last_reply || formatText(SAMPLE_LINE, { name }), voice_sample: true };
}

/** Text or Portuguese translation of the tutor's last voice note (the voice-note buttons). */
async function lastReply(
  state: ConversationState,
  ctx: GraphContext,
  translateIt: boolean,
): Promise<Update> {
  const t = textsOf(state);
  const last = state.last_reply || "";
  if (!last) return { outbound_texts: [t.noLastReply] };
  if (!translateIt) return { outbound_texts: [formatText(t.transcript, { text: last })] };
  const [translation, update] = await translate(state, ctx, last, "English", "Portuguese");
  const text = translation ? formatText(t.translation, { text: translation }) : t.translateFailed;
  return { ...update, outbound_texts: [text] };
}

/** /meta: today's practices against the goal and the way to the next level. */
async function goalStatus(state: ConversationState, ctx: GraphContext): Promise<string> {
  const t = textsOf(state);
  const level = levelOf(state);
  const since = localMidnight(ctx.config.timezone);
  const stats = await ctx.repo.practiceStats(state.user_id, since, level, GOOD_SCORE);
  const next = nextLevel(level);
  const need = LEVEL_UP[level];
  const levelLine =
    next && need
      ? formatText(t.levelTowards, {
          next,
          good: Math.min(stats.goodAtLevel, need),
          need,
          min: GOOD_SCORE,
        })
      : t.levelTop;
  return formatText(t.goalShow, {
    done: stats.today,
    goal: goalOf(state.daily_goal),
    level_line: levelLine,
    cmd: t.cmdGoal,
    max: MAX_DAILY_GOAL,
  });
}
