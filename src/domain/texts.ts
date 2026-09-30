/**
 * Fixed user-facing texts in the student's chosen language (/idioma).
 *
 * English is the default and the recommended choice: the whole chat becomes practice. Portuguese
 * stays available for beginners. The tutor always speaks English; the self-harm message is always
 * in Portuguese (the students are Brazilian, and that is not the moment for practice).
 *
 * Templates use `{name}` placeholders; fill them with `formatText`.
 */

import { formatFixed } from "./format.js";
import { LEVELS, SUGGESTED_TOPICS } from "./topics.js";

export type Lang = "en" | "pt";
export const DEFAULT_LANG: Lang = "en";

const SELF_HARM =
  "Sinto muito que você esteja passando por isso. Você não está sozinho: o CVV atende 24 h, " +
  "de graça, pelo telefone *188* ou em cvv.org.br. Se estiver em perigo agora, ligue *192*.";

function numbered(items: readonly string[]): string {
  return items.map((t, i) => `${i + 1}. ${t}`).join("\n");
}

/** Fills named fields: "{topic}" -> values.topic, "{{" -> "{", "}}" -> "}".
 * A missing field throws. */
export function formatText(template: string, values: Record<string, unknown>): string {
  return template.replace(/\{\{|\}\}|\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (match, name?: string) => {
    if (match === "{{") return "{";
    if (match === "}}") return "}";
    if (name === undefined || !Object.hasOwn(values, name)) {
      throw new Error(`missing format field: ${name ?? match}`);
    }
    return String(values[name]);
  });
}

export interface TextsData {
  readonly lang: Lang;
  readonly welcome: string; // {tutor}
  readonly welcomeBack: string; // {topic}
  readonly help: string;
  readonly topicList: string; // text-only channels: the topics as a numbered list
  readonly topicSet: string; // {topic}
  readonly levelShow: string; // {level} {levels}
  readonly levelSet: string; // {level}
  readonly levelInvalid: string; // {levels}
  readonly resetDone: string;
  readonly unknownCommand: string;
  readonly tutorSet: string; // {tutor} {description}
  readonly speedSet: string; // {speed} {name}
  readonly languageSet: string;
  readonly blocked: Readonly<Record<string, string>>; // {topic} {max_chars} {max_seconds} {limit}
  readonly evaluationUnavailable: string;
  readonly transcript: string; // {text}
  readonly translation: string; // {text}
  readonly noLastReply: string;
  readonly translateFailed: string;
  readonly portugueseHelp: string; // {english}
  readonly portugueseHelpAudio: string; // {english}
  readonly portugueseHelpPlain: string;
  readonly audioNudge: string;
  readonly heardUnsure: string; // {heard}: caption note when the transcript may be wrong
  readonly heardRetry: string; // {heard}: too unsure to grade, but show what was heard
  // --- accounts (accounts/gate): at most once a day for the same number ---
  readonly notEnrolled: string; // {signup_url}
  readonly accountBlocked: string; // {contact}
  readonly planExpired: string; // {contact} {panel_url}
  readonly codeUnknown: string;
  readonly codeWrongPhone: string;
  readonly resetConfirmed: string;
  readonly messagesLeft: string; // {n}
  readonly planChanged: string; // {old} {plan} {limit} {panel_url}
  readonly planLimit: string; // {n}
  readonly planUnlimited: string;
  // --- plans and goals ---
  readonly paidOnly: string; // menu rows the plan does not offer
  readonly tutorLocked: string; // {tutor} {offered}
  readonly speedLocked: string; // {speed} {offered}
  readonly goalShow: string; // {done} {goal} {level_line} {cmd} {max}
  readonly goalTooHigh: string; // {limit}
  readonly goalSet: string; // {goal}
  readonly goalReached: string; // {goal}
  readonly levelTowards: string; // {next} {good} {need} {min}
  readonly levelTop: string;
  readonly levelUp: string; // {previous} {level} {need} {cmd}
  readonly cmdGoal: string;
  readonly cmdLevel: string;
  // --- menus (see domain/choices.ts) ---
  readonly voiceHelpBody: string;
  readonly voiceHelpTitles: readonly [string, string, string]; // transcribe, translate, menu (<= 20)
  readonly voiceHelpFallback: string;
  readonly menuBody: string;
  readonly menuButton: string;
  // option id -> [title <= 24, description <= 72]
  readonly menuRows: Readonly<Record<string, readonly [string, string]>>;
  readonly menuFallback: string;
  readonly topicBody: string; // {current} {cmd}
  readonly topicButton: string;
  readonly topicNames: Readonly<Record<string, string>>;
  readonly levelBody: string; // {current}
  readonly levelButton: string;
  readonly levelNames: Readonly<Record<string, string>>;
  readonly tutorBody: string; // {current}
  readonly tutorButton: string;
  readonly accents: Readonly<Record<string, string>>;
  readonly genders: Readonly<Record<string, string>>;
  readonly speedBody: string; // {current}
  readonly speedButton: string;
  readonly speedNames: Readonly<Record<string, string>>;
  readonly languageBody: string;
  readonly cmdTopic: string;
  readonly cmdVoice: string;
  readonly cmdSpeed: string;
  readonly decimal: string;
  readonly articles: Readonly<Record<string, string>>; // gender -> "a " / "o "
}

export interface Texts extends TextsData {
  tutorDescription(accent: string, gender: string): string;
  tutorCalled(name: string, gender: string): string;
  speedLabel(speed: number): string;
}

type TextsInit = Omit<TextsData, "decimal" | "articles"> &
  Partial<Pick<TextsData, "decimal" | "articles">>;

function makeTexts(init: TextsInit): Texts {
  const data: TextsData = { decimal: ".", articles: {}, ...init };
  return Object.freeze({
    ...data,
    tutorDescription(accent: string, gender: string): string {
      const a = data.accents[accent];
      const g = data.genders[gender];
      if (a === undefined || g === undefined) throw new Error(`unknown voice ${accent}/${gender}`);
      return `${a}, ${g}`;
    },
    tutorCalled(name: string, gender: string): string {
      return `${data.articles[gender] ?? ""}${name}`;
    },
    speedLabel(speed: number): string {
      return `${formatFixed(speed, 1)}x`.replace(".", data.decimal);
    },
  });
}

export const EN: Texts = makeTexts({
  lang: "en",
  welcome:
    "Hi! Welcome to *saybest*. You'll practice English conversation with {tutor}.\n\n" +
    "Send a *voice message in English* (or text) and I'll reply with an image with your " +
    "corrections and a voice note to keep the conversation going.\n\n" +
    "For quick lessons with exercises, send /aula. " +
    "To change the topic, level, voice or speed, send /menu at any time.\n\n" +
    "🇧🇷 Prefere as mensagens em português? Mande /idioma pt.",
  welcomeBack:
    "Good to see you again! 👋 Let's get back to *{topic}* with a new question.\n" +
    "To change the topic, level, voice or speed, send /menu.",
  help:
    "*How it works*\n" +
    "Record a voice message in English answering the question. You get an image with what " +
    "was right, what to fix and a score from 0 to 100, and a voice note to continue.\n\n" +
    "*Commands*\n" +
    "/aula - a quick lesson with exercises (words, listening, speaking)\n" +
    "/revisar - review what you learned\n" +
    "/topic - see the topics\n/topic 2 or /topic travel - change the topic\n" +
    `/level B1 - set your level (${LEVELS.join(", ")})\n` +
    "/voice - choose who talks to you (accent and voice)\n" +
    "/speed - make the voice slower\n" +
    "/transcribe - read the last voice note\n" +
    "/translate - translate the last voice note into Portuguese\n" +
    "/language - messages in English or Portuguese\n" +
    "/goal - your daily goal and the way to the next level\n" +
    "/menu - all options\n" +
    "/reset - start over",
  topicList: `*Suggested topics*\n${numbered(SUGGESTED_TOPICS)}\n\nSend /topic 2 or /topic <any topic>.`,
  topicSet: "Topic: *{topic}*. Listen to the voice note and answer by speaking English!",
  levelShow: "Your current level is *{level}*. To change it: /level B2 ({levels}).",
  levelSet: "Level set to *{level}*.",
  levelInvalid: "Invalid level. Use one of these: {levels}.",
  resetDone: "Conversation restarted.",
  unknownCommand: "I don't know that command. Send /help to see the options.",
  tutorSet: "Now you're talking with {tutor} ({description}). Listen:",
  speedSet: "Speaking speed: *{speed}* ({name}). Listen:",
  languageSet: "Done! Messages are now in *English*. 🇬🇧",
  blocked: {
    off_topic:
      "I can only help you practice English. How about telling me something " + "about *{topic}*?",
    injection: "Let's keep the focus on English! Tell me something about *{topic}*.",
    inappropriate: "I can't talk about that. Shall we get back to *{topic}*?",
    self_harm: SELF_HARM,
    busy: "I'm very busy right now 😅 Please try again in a few minutes!",
    too_long:
      "That message is too long. Try something shorter (up to {max_chars} " +
      "characters or {max_seconds} seconds of audio).",
    empty: "I didn't get any text. Send a voice message or a message in English.",
    rate_limited: "Easy! You sent many messages in a row. Wait a minute.",
    budget: "You've reached today's practice limit. Come back tomorrow!",
    unsupported: "For now I only understand voice and text. Send a voice message in English!",
    low_confidence:
      "I couldn't understand the audio. Could you record it again, " +
      "somewhere quieter, speaking a little slower?",
    stt_error: "I had trouble hearing your audio. Could you send it again?",
    daily_limit: "You've used your {limit} messages for today. See you tomorrow! 🙂",
  },
  evaluationUnavailable: "I couldn't create the corrections this time, but let's keep going!",
  transcript: "📝 *Last voice note:*\n\n{text}",
  translation: "🇧🇷 *Translation of the last voice note:*\n\n{text}",
  noLastReply: "There's no voice note for that yet. Send a voice message in English to start!",
  translateFailed:
    "I couldn't translate it now. Try again in a moment, or use /transcribe to " + "read the text.",
  portugueseHelp:
    "That's Portuguese 🙂 In English it's:\n\n*{english}*\n\n" +
    "Now you try: answer *in English*, ideally by *voice* 🎙️ to practice speaking.\n" +
    "To read the last voice note again: /transcribe",
  portugueseHelpAudio:
    "That audio sounds like Portuguese 🙂 In English it's:\n\n*{english}*\n\n" +
    "Now try saying it in English!",
  portugueseHelpPlain:
    "That's Portuguese 🙂 Try answering *in English*, ideally by *voice* 🎙️. " +
    'If you miss a word, you can mix: "I went to the praia" is fine too!',
  audioNudge: "🎙️ Tip: answer by *voice* to practice speaking too.",
  heardUnsure:
    '🎧 I heard: "{heard}". If you said something else, try again a little slower: ' +
    "that also trains your pronunciation.",
  heardRetry:
    '🎧 I\'m not sure I understood. I heard: "{heard}". Could you say it again, a little ' +
    "slower and closer to the microphone?",
  notEnrolled:
    "Hi! 👋 This is *saybest*, an English conversation coach. To use it, create your " +
    "free account: {signup_url}",
  accountBlocked: "Your account is paused. {contact}",
  planExpired: "Your plan has ended. {contact} Your progress is still at {panel_url}",
  codeUnknown: "That code is not valid or has expired. Generate a new one on the website.",
  codeWrongPhone:
    "That code was created for another phone number. Send it from the number you typed " +
    "on the website.",
  resetConfirmed: "Code confirmed ✅ Go back to the website to choose your new password.",
  messagesLeft: "{n} messages left today.",
  planChanged:
    "Your *{old}* period has ended. You're now on the *{plan}* plan ({limit}). " +
    "Your progress is at {panel_url}",
  planLimit: "{n} messages a day",
  planUnlimited: "no daily limit",
  paidOnly: "🔒 paid plans",
  tutorLocked: "🔒 {tutor} is part of the paid plans. On your plan you can talk with {offered}.",
  speedLocked: "🔒 The {speed} speed is part of the paid plans. On your plan: {offered}.",
  goalShow:
    "🎯 *Daily goal:* {done} of {goal} practices today.\n🎓 {level_line}\n\n" +
    "To change your daily goal, send {cmd} and a number from 1 to {max} (e.g. {cmd} 8).",
  goalTooHigh: "Your plan has {limit} messages a day, so your goal can be up to {limit}.",
  goalSet: "Daily goal set to *{goal} practices a day*. 🎯",
  goalReached:
    "🎯 Daily goal reached: {goal} practices today! Come back tomorrow to keep your streak.",
  levelTowards: "Towards *{next}*: {good} of {need} answers scoring {min} or more.",
  levelTop: "You're at the top level, *C2*! 🏆",
  levelUp:
    "🎓 *Level up!* {need} good answers at {previous}: you're now at *{level}*. " +
    "The questions get a little harder. To go back: {cmd} {previous}",
  cmdGoal: "/goal",
  cmdLevel: "/level",
  voiceHelpBody: "Need help with the audio?",
  voiceHelpTitles: ["📝 Transcribe", "🇧🇷 Translate", "☰ Menu"],
  voiceHelpFallback: "Need help with the audio? Send /transcribe or /translate. Menu: /menu",
  menuBody: "What would you like to do?",
  menuButton: "Open menu",
  menuRows: {
    aula: ["📚 Quick lesson", "10 exercises: words, listening and speaking"],
    tema: ["🔄 Change topic", "Pick another subject to talk about"],
    nivel: ["📶 Change level", "Make the conversation easier or harder"],
    voz: ["🗣️ Change voice", "British or American accent, female or male voice"],
    velocidade: ["🐢 Speaking speed", "Make the voice notes slower"],
    meta: ["🎯 Daily goal", "Your goal for today and the way to the next level"],
    idioma: ["🌐 Language / Idioma", "Messages in English or Portuguese"],
    reset: ["🆕 Start over", "Restart the conversation from scratch"],
  },
  menuFallback:
    "*Menu*\n/aula - quick lesson\n/topic - change the topic\n/level - change the level\n/voice - change the " +
    "voice\n/speed - speaking speed\n/goal - daily goal\n/language - English or Portuguese\n" +
    "/reset - start over" +
    "\n/help - how it works",
  topicBody:
    "Current topic: *{current}*.\nPick a topic from the list, or send {cmd} and any " +
    "subject (e.g. {cmd} football).",
  topicButton: "See topics",
  topicNames: {
    "introducing yourself": "Talk about who you are",
    "job interview": "Practice answering an interviewer",
    "ordering at a restaurant": "Role-play with a waiter",
    travel: "Trips, places and plans",
    shopping: "Stores, prices and buying things",
    "daily routine": "Your day, habits and schedule",
  },
  levelBody: "Your current level is *{current}*. Choose the conversation level:",
  levelButton: "See levels",
  levelNames: {
    A1: "Beginner: very simple everyday sentences",
    A2: "Elementary: short talks about familiar things",
    B1: "Intermediate: share experiences and opinions",
    B2: "Upper intermediate: talk with fluency",
    C1: "Advanced: express yourself naturally",
    C2: "Proficient: almost like a native speaker",
  },
  tutorBody: "You're talking with *{current}*. Pick another voice:",
  tutorButton: "See voices",
  accents: { british: "British accent", american: "American accent" },
  genders: { female: "female voice", male: "male voice" },
  speedBody: "Current speed: *{current}*. Choose the speaking speed:",
  speedButton: "See speeds",
  speedNames: {
    "100": "Normal",
    "90": "A little slower",
    "80": "Slow",
    "70": "Very slow (beginners)",
  },
  languageBody:
    "Which language do you want for my messages? English is recommended: " +
    "the whole chat becomes practice. (Prefere português? Toque em Português.)",
  cmdTopic: "/topic",
  cmdVoice: "/voice",
  cmdSpeed: "/speed",
});

export const PT: Texts = makeTexts({
  lang: "pt",
  welcome:
    "Olá! Bem-vindo ao *saybest*. Quem vai conversar com você em inglês é {tutor}.\n\n" +
    "Mande um *áudio em inglês* (ou texto) e eu respondo com uma imagem com suas correções " +
    "e um áudio continuando a conversa.\n\n" +
    "Para aulas rápidas com exercícios, mande /aula. " +
    "Para trocar de tema, nível, voz ou velocidade, mande /menu a qualquer momento.\n\n" +
    "🇬🇧 Dica: com as mensagens em inglês você pratica ainda mais. Mande /idioma en.",
  welcomeBack:
    "Que bom te ver de novo! 👋 Vamos retomar o tema *{topic}* com uma pergunta nova.\n" +
    "Para trocar de tema, nível, voz ou velocidade, mande /menu.",
  help:
    "*Como funciona*\n" +
    "Grave um áudio em inglês respondendo à pergunta. Você recebe uma imagem com o que " +
    "estava certo, o que corrigir e uma nota de 0 a 100, e um áudio para continuar.\n\n" +
    "*Comandos*\n" +
    "/aula - uma aula rápida com exercícios (palavras, escuta, fala)\n" +
    "/revisar - revisar o que você aprendeu\n" +
    "/tema - ver os temas\n/tema 2 ou /tema travel - trocar de tema\n" +
    `/nivel B1 - ajustar o nível (${LEVELS.join(", ")})\n` +
    "/voz - escolher quem fala com você (sotaque e voz)\n" +
    "/velocidade - deixar a fala mais devagar\n" +
    "/transcrever - ler o último áudio\n" +
    "/traduzir - traduzir o último áudio\n" +
    "/idioma - mensagens em inglês ou português\n" +
    "/meta - sua meta diária e o caminho para o próximo nível\n" +
    "/menu - todas as opções\n" +
    "/reset - começar do zero",
  topicList: `*Temas sugeridos*\n${numbered(SUGGESTED_TOPICS)}\n\nUse /tema 2 ou /tema <qualquer tema>.`,
  topicSet: "Tema: *{topic}*. Ouça o áudio e responda falando em inglês!",
  levelShow: "Seu nível atual é *{level}*. Para mudar: /nivel B2 ({levels}).",
  levelSet: "Nível ajustado para *{level}*.",
  levelInvalid: "Nível inválido. Use um destes: {levels}.",
  resetDone: "Conversa reiniciada.",
  unknownCommand: "Não conheço esse comando. Mande /ajuda para ver as opções.",
  tutorSet: "Agora quem conversa com você é {tutor} ({description}). Ouça:",
  speedSet: "Velocidade da fala: *{speed}* ({name}). Ouça:",
  languageSet: "Pronto! As mensagens agora estão em *português*. 🇧🇷",
  blocked: {
    off_topic:
      "Eu só consigo ajudar a praticar inglês. Que tal me contar algo sobre " + "*{topic}*?",
    injection: "Vamos manter o foco no inglês! Me conte algo sobre *{topic}*.",
    inappropriate: "Não posso conversar sobre isso. Vamos voltar ao tema *{topic}*?",
    self_harm: SELF_HARM,
    busy: "Estou com muita procura agora 😅 Tente de novo daqui a alguns minutos!",
    too_long:
      "Essa mensagem ficou longa demais. Tente algo mais curto (até {max_chars} " +
      "caracteres ou {max_seconds} segundos de áudio).",
    empty: "Não recebi nenhum texto. Mande um áudio ou uma mensagem em inglês.",
    rate_limited: "Calma! Você mandou muitas mensagens seguidas. Espere um minuto.",
    budget: "Você atingiu o limite de prática de hoje. Volte amanhã!",
    unsupported: "Por enquanto eu entendo só áudio e texto. Mande um áudio em inglês!",
    low_confidence:
      "Não consegui entender bem o áudio. Pode gravar de novo, num lugar " +
      "mais silencioso e falando um pouco mais devagar?",
    stt_error: "Tive um problema para ouvir seu áudio. Pode mandar de novo?",
    daily_limit: "Você usou suas {limit} mensagens de hoje. Até amanhã! 🙂",
  },
  evaluationUnavailable: "Não consegui gerar a correção desta vez, mas vamos continuar!",
  transcript: "📝 *Último áudio:*\n\n{text}",
  translation: "🇧🇷 *Tradução do último áudio:*\n\n{text}",
  noLastReply: "Ainda não tem áudio para isso. Mande um áudio em inglês para começar!",
  translateFailed:
    "Não consegui traduzir agora. Tente de novo em instantes, ou use " +
    "/transcrever para ler o texto.",
  portugueseHelp:
    "Isso está em português 🙂 Em inglês fica:\n\n*{english}*\n\n" +
    "Agora tente você: responda *em inglês*, de preferência por *áudio* 🎙️ para treinar a " +
    "fala.\nPara ler de novo a última fala: /transcrever",
  portugueseHelpAudio:
    "Esse áudio parece estar em português 🙂 Em inglês fica:\n\n*{english}*\n\n" +
    "Agora tente dizer isso em inglês!",
  portugueseHelpPlain:
    "Isso está em português 🙂 Tente responder *em inglês*, de preferência por *áudio* 🎙️. " +
    'Se faltar uma palavra, pode misturar: "I went to the praia" também vale!',
  audioNudge: "🎙️ Dica: responda por *áudio* para treinar também a fala.",
  heardUnsure:
    '🎧 Entendi: "{heard}". Se você disse outra coisa, tente de novo um pouco mais devagar: ' +
    "isso também treina a pronúncia.",
  heardRetry:
    '🎧 Não tenho certeza se entendi. Ouvi: "{heard}". Pode repetir um pouco mais devagar ' +
    "e mais perto do microfone?",
  notEnrolled:
    "Olá! 👋 Aqui é o *saybest*, um tutor de conversação em inglês. Para usar, crie sua " +
    "conta grátis: {signup_url}",
  accountBlocked: "Sua conta está pausada. {contact}",
  planExpired: "Seu plano terminou. {contact} Seu progresso continua em {panel_url}",
  codeUnknown: "Esse código não é válido ou expirou. Gere um novo no site.",
  codeWrongPhone:
    "Esse código foi criado para outro número. Envie do número que você digitou no site.",
  resetConfirmed: "Código confirmado ✅ Volte ao site para escolher sua nova senha.",
  messagesLeft: "Restam {n} mensagens hoje.",
  planChanged:
    "Seu período *{old}* terminou. Agora você está no plano *{plan}* ({limit}). " +
    "Seu progresso fica em {panel_url}",
  planLimit: "{n} mensagens por dia",
  planUnlimited: "sem limite diário",
  paidOnly: "🔒 planos pagos",
  tutorLocked: "🔒 {tutor} faz parte dos planos pagos. No seu plano você conversa com {offered}.",
  speedLocked: "🔒 A velocidade {speed} faz parte dos planos pagos. No seu plano: {offered}.",
  goalShow:
    "🎯 *Meta do dia:* {done} de {goal} práticas hoje.\n🎓 {level_line}\n\n" +
    "Para mudar a meta diária, mande {cmd} e um número de 1 a {max} (ex.: {cmd} 8).",
  goalTooHigh: "Seu plano tem {limit} mensagens por dia, então a meta pode ser de até {limit}.",
  goalSet: "Meta diária ajustada para *{goal} práticas por dia*. 🎯",
  goalReached: "🎯 Meta do dia batida: {goal} práticas hoje! Volte amanhã para manter a sequência.",
  levelTowards: "Rumo ao *{next}*: {good} de {need} respostas com nota {min} ou mais.",
  levelTop: "Você está no nível máximo, *C2*! 🏆",
  levelUp:
    "🎓 *Subiu de nível!* {need} boas respostas no {previous}: agora você está no *{level}*. " +
    "As perguntas ficam um pouco mais difíceis. Para voltar: {cmd} {previous}",
  cmdGoal: "/meta",
  cmdLevel: "/nivel",
  voiceHelpBody: "Precisa de ajuda com o áudio?",
  voiceHelpTitles: ["📝 Transcrever", "🇧🇷 Traduzir", "☰ Menu"],
  voiceHelpFallback:
    "Precisa de ajuda com o áudio? Mande /transcrever ou /traduzir. " + "Menu: /menu",
  menuBody: "O que você quer fazer?",
  menuButton: "Abrir menu",
  menuRows: {
    aula: ["📚 Aula rápida", "10 exercícios: palavras, escuta e fala"],
    tema: ["🔄 Trocar tema", "Escolher outro assunto para conversar"],
    nivel: ["📶 Mudar nível", "Deixar a conversa mais fácil ou mais difícil"],
    voz: ["🗣️ Trocar voz", "Sotaque britânico ou americano, voz feminina ou masculina"],
    velocidade: ["🐢 Velocidade da fala", "Deixar os áudios mais devagar"],
    meta: ["🎯 Meta diária", "Sua meta de hoje e o caminho para o próximo nível"],
    idioma: ["🌐 Language / Idioma", "Mensagens em inglês (recomendado) ou português"],
    reset: ["🆕 Recomeçar", "Começar a conversa do zero"],
  },
  menuFallback:
    "*Menu*\n/aula - aula rápida\n/tema - trocar de tema\n/nivel - mudar o nível\n/voz - trocar a voz\n" +
    "/velocidade - velocidade da fala\n/meta - meta diária\n/idioma - inglês ou português\n" +
    "/reset - recomeçar a conversa\n/ajuda - como funciona",
  topicBody:
    "Tema atual: *{current}*.\nEscolha um tema na lista, ou mande {cmd} e qualquer " +
    "assunto (ex.: {cmd} football).",
  topicButton: "Ver temas",
  topicNames: {
    "introducing yourself": "Apresentar-se",
    "job interview": "Entrevista de emprego",
    "ordering at a restaurant": "Pedir num restaurante",
    travel: "Viagens",
    shopping: "Compras",
    "daily routine": "Rotina diária",
  },
  levelBody: "Seu nível atual é *{current}*. Escolha o nível da conversa:",
  levelButton: "Ver níveis",
  levelNames: {
    A1: "Iniciante: frases bem simples do dia a dia",
    A2: "Básico: conversas curtas sobre coisas conhecidas",
    B1: "Intermediário: conta experiências e opiniões",
    B2: "Intermediário avançado: conversa com fluência",
    C1: "Avançado: se expressa com naturalidade",
    C2: "Proficiente: quase como nativo",
  },
  tutorBody: "Quem conversa com você agora é *{current}*. Escolha outra voz:",
  tutorButton: "Ver vozes",
  accents: { british: "sotaque britânico", american: "sotaque americano" },
  genders: { female: "voz feminina", male: "voz masculina" },
  speedBody: "Velocidade atual: *{current}*. Escolha a velocidade da fala:",
  speedButton: "Ver velocidades",
  speedNames: {
    "100": "Normal",
    "90": "Um pouco mais devagar",
    "80": "Devagar",
    "70": "Bem devagar (iniciantes)",
  },
  languageBody:
    "Em que idioma você quer as minhas mensagens? Recomendo *inglês*: a conversa " +
    "inteira vira prática.",
  cmdTopic: "/tema",
  cmdVoice: "/voz",
  cmdSpeed: "/velocidade",
  decimal: ",",
  articles: { female: "a ", male: "o " },
});

export const TEXTS: Readonly<Record<Lang, Texts>> = { en: EN, pt: PT };

export function textsFor(lang: string | null | undefined): Texts {
  return lang === "en" || lang === "pt" ? TEXTS[lang] : TEXTS[DEFAULT_LANG];
}

export function parseLang(arg: string): Lang | null {
  const value = arg.trim().toLowerCase();
  if (["en", "english", "ingles", "inglês", "1"].includes(value)) return "en";
  if (["pt", "portugues", "português", "portuguese", "pt-br", "2"].includes(value)) return "pt";
  return null;
}
