/**
 * Deterministic input checks, run BEFORE any LLM call (cheap, and cannot be talked out of).
 *
 * They reduce injection attempts; they do not prevent them. The critical controls live outside
 * the model: it has no tools, sees only this student's data, and never decides who gets what.
 */

import type { Settings } from "../config.js";
import { pyLen, pyRe, pyStrip } from "./py-re.js";

// Obvious injection / jailbreak phrasings (English and Portuguese). Kept narrow on purpose:
// a false positive blocks a learner; the LLM guard catches subtler cases.
const INJECTION_PATTERNS = [
  // "ignore/disregard/forget (all|your|the) previous/above instructions|prompt|rules"
  String.raw`\b(ignore|disregard|forget)\s+(all\s+|any\s+)?(of\s+)?(your|the|my|these|those)?\s*` +
    String.raw`(previous|prior|above|earlier|initial|system)\s+(instructions?|prompts?|rules|messages?)\b`,
  String.raw`\b(ignore|disregard|forget)\s+(all\s+)?your\s+(instructions?|prompt|rules|guidelines)\b`,
  String.raw`\b(system|developer)\s+(prompt|message|mode)\b`,
  String.raw`\b(reveal|show|print|repeat|tell\s+me)\b.{0,20}\byour\s+(instructions?|prompt|rules)\b`,
  String.raw`\byou\s+are\s+now\s+(DAN|an?\s+(AI|assistant|bot|chatbot|model)|in\s+\w+\s+mode|free)\b`,
  String.raw`\bfrom\s+now\s+on,?\s+you\s+(will|must|should)\s+(answer|respond|reply|act|only)\b`,
  String.raw`\b(jailbreak|DAN mode|do anything now)\b`,
  String.raw`</?\s*(system|assistant|student_answer|context|history|topic)\s*>`,
  String.raw`\bignor(e|ar|a)\s+(as\s+|todas\s+as\s+|suas\s+)?(instru[cç](ões|oes)|regras)\b`,
  String.raw`\bprompt\s+do\s+sistema\b`,
  String.raw`\b(mostre|revele|repita)\b.{0,20}\bsuas\s+(instru[cç](ões|oes)|regras)\b`,
];
const INJECTION_RE = pyRe(INJECTION_PATTERNS.join("|"), "i");

// Clearly harmful requests, blocked without any model: the LLM guard fails open when it is
// unavailable (quota, outage), and these must never reach the tutor. Narrow on purpose.
const HARMFUL_RE = pyRe(
  String.raw`\b(make|build|making|building|create|assemble|fazer|construir|fabricar|montar)\b.{0,30}` +
    String.raw`\b(bombs?|explosives?|molotov|detonators?|guns?|firearms?|bombas?|explosivos?|armas?)\b` +
    String.raw`|\b(how to|how do i|como)\b.{0,25}\b(kill|murder|poison|matar|assassinar|envenenar)\b` +
    String.raw`|\b(make|cook|synthesi[sz]e|produce|fazer|produzir)\b.{0,25}` +
    String.raw`\b(meth|methamphetamine|cocaine|heroin|crack|lsd|coca[ií]na|metanfetamina|hero[ií]na)\b` +
    String.raw`|\b(child|children|kids?|minors?|crian[cç]as?|menor(es)?)\b.{0,30}` +
    String.raw`\b(sex|sexual|porn|nudes?|naked|pelad[ao]s?|pornografia)` +
    String.raw`|\b(sex|sexual|porn|nudes?|naked|pelad[ao]s?|pornografia)\b.{0,30}` +
    String.raw`\b(child|children|kids?|minors?|crian[cç]as?|menor(es)?)\b`,
  "i",
);
const SELF_HARM_RE = pyRe(
  String.raw`\b(kill|hurt|harm)\s+myself\b|\bsuicid|\bself[- ]harm|\bme\s+matar\b|\bautoles` +
    String.raw`|\bn[aã]o\s+quero\s+mais\s+viver\b|\bwant\s+to\s+die\b`,
  "i",
);

export type BlockReason = "empty" | "too_long" | "self_harm" | "inappropriate" | "injection";

/** Return a block reason (key of texts_pt.BLOCKED) or null if the text may proceed. */
export function checkText(
  text: string,
  settings: Pick<Settings, "maxTextChars">,
): BlockReason | null {
  if (!pyStrip(text)) return "empty";
  if (pyLen(text) > settings.maxTextChars) return "too_long";
  if (SELF_HARM_RE.test(text)) return "self_harm";
  if (HARMFUL_RE.test(text)) return "inappropriate";
  if (INJECTION_RE.test(text)) return "injection";
  return null;
}

// "Is the student writing in Portuguese instead of English?" Counted by distinctive words, like
// output_rules.looks_english: a few Portuguese words inside an English sentence ("I went to the
// praia") are normal practice and still get evaluated. Words that are also English ("no", "a",
// "me", "so", "as", "um", "era", "ali") are left out on purpose, and a single hit only counts
// for a standalone greeting-like word ("Olá", "Obrigado"): "Eu", "Casa" or "Pedro e Ana" alone
// are names or ambiguous. Text only in practice: Whisper small.en turns Portuguese speech into
// English, so audio rarely reaches this check.
const WORD_RE = pyRe(String.raw`[\p{L}\p{Nl}\p{No}]+(?:'[\p{L}\p{Nl}\p{No}]+)?`, "g"); // [^\W\d_]
const PORTUGUESE_WORDS = new Set(
  (
    "olá ola oi tudo bom boa bem tarde noite dia obrigado obrigada valeu tchau beleza " +
    "você voce vocês voces eu meu minha meus minhas seu sua nós nos ele ela eles elas " +
    "que não nao sim é e está esta estou estava sou foi fui tenho tem tinha fazer faço " +
    "gosto gosta gostei quero queria posso pode sei acho vou vai vamos ir " +
    "de do da dos das na num numa em com para pra por porque mas também tambem muito " +
    "muita isso isto aqui então entao hoje ontem amanhã amanha agora sempre nunca " +
    "uma uns umas o os ao aos pelo pela como onde quando qual quem trabalho casa " +
    "falar fala inglês ingles português portugues ajuda entendi desculpa"
  ).split(" "),
);
const ENGLISH_WORDS = new Set(
  (
    "hi hello hey the and you your i i'm it it's is are was were what how why when where " +
    "who that this there do did does have has had can could would will like just about my " +
    "we they he she to of in on at for with from yes not but very good thanks thank"
  ).split(" "),
);

const STANDALONE = new Set(
  "olá ola oi obrigado obrigada valeu tchau sim não nao beleza".split(" "),
);

export function looksPortuguese(text: string): boolean {
  const words = Array.from(text.matchAll(WORD_RE), (m) => m[0].toLowerCase());
  const hits = words.filter((w) => PORTUGUESE_WORDS.has(w));
  const english = words.filter((w) => ENGLISH_WORDS.has(w)).length;
  if (hits.length === 1) {
    return english === 0 && words.length <= 2 && STANDALONE.has(hits[0] as string);
  }
  return hits.length > english && hits.length * 4 >= words.length;
}

// 'off_topic' means asking the bot to do other work. A statement about the student's own life
// ("i am software enginner" while the topic is daily routine) never is, whatever a free model
// says: without one of these cues, an off_topic verdict is overridden.
const REQUEST_RE = pyRe(
  String.raw`\?|^\s*(?:please\s+)?(?:write|create|make|generate|code|program|build|solve|calculate|` +
    `compute|translate|summari[sz]e|explain|search|find|list|give|show|tell|help|do|fix|debug|` +
    String.raw`draw|design|send)\b|\b(?:can|could|would|will)\s+you\b|\bplease\b|\bhelp\s+me\b|` +
    String.raw`\bi\s+(?:need|want)\s+you\b|\bhow\s+(?:do|can|to)\b`,
  "i",
);

export function looksLikeRequest(text: string): boolean {
  return REQUEST_RE.test(text);
}
