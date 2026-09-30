/**
 * Fixed texts of the course mode (/aula), in the student's language (/idioma). Word meanings,
 * tips and translations are always Portuguese: the course is for Brazilian learners.
 * Templates use `{name}` placeholders (domain/texts formatText).
 */

export interface CourseTexts {
  readonly firstLesson: string; // shown above the first exercise ever
  readonly lessonHeader: string; // {n} {total}
  readonly reviewHeader: string; // {n} {total}
  readonly meaning: string; // {word} {example}
  readonly word: string; // {pt}
  readonly listen: string;
  readonly cloze: string; // {sentence} {pt}
  readonly type: string; // {pt}
  readonly order: string; // {pt} {tiles}
  readonly dictation: string;
  readonly translate: string; // {pt}
  readonly repeat: string; // {en}
  readonly say: string; // {pt}
  readonly fix: string; // {pt} {options}
  readonly falseFriend: string; // {word}
  readonly pair: string; // {sound}
  readonly chat: string; // {context} {them}
  readonly mistake: string; // {said}
  readonly labelled: string; // "A) ... B) ..." fallback under the question: {options}
  readonly right: readonly string[];
  readonly almost: string; // typos: {words}
  readonly wrong: string; // {answer}
  readonly skipped: string; // {answer}
  readonly spoken: string; // {score} {heard}
  readonly spokenWeak: string; // {words}
  readonly spokenRetry: string; // could not hear: ask again, not graded
  readonly chooseHint: string; // an answer that is none of the options: {n}
  readonly typeHint: string; // audio where text was expected
  readonly voiceHint: string; // text where audio was expected
  readonly stale: string; // a button of an old exercise
  readonly paused: string;
  readonly resumed: string;
  readonly finished: string; // {correct} {total} {points}
  readonly finishedNew: string; // {words}
  readonly finishedDue: string; // {n}
  readonly nothingToReview: string;
  readonly dailyLimit: string; // {n}
  readonly unavailable: string; // no content on this server
  readonly dontKnow: string; // button, <= 20 chars
  readonly stop: string; // button
  readonly again: string; // button: another lesson
  readonly review: string; // button
  readonly menu: string; // button
  readonly optionsButton: string; // list button for more than 3 options
}

export const COURSE_PT: CourseTexts = {
  firstLesson:
    "📚 *Aula rápida*: 10 exercícios de palavras, frases, escuta e fala. Toque nas opções, " +
    "escreva ou mande áudio quando eu pedir. Para parar: /sair",
  lessonHeader: "*{n}/{total}*",
  reviewHeader: "*Revisão {n}/{total}*",
  meaning: "O que significa *{word}*?{example}",
  word: "Como se diz *{pt}* em inglês?",
  listen: "🎧 Qual palavra você ouviu?",
  cloze: "Complete a frase:\n\n*{sentence}*\n_{pt}_",
  type: "✍️ Escreva em inglês: *{pt}*",
  order:
    "🧩 Monte a frase em inglês: _{pt}_\n\n{tiles}\n\nMande os números na ordem (ex.: 3 1 2) ou escreva a frase.",
  dictation: "🎧 Escreva em inglês a frase que você ouviu.",
  translate: "✍️ Traduza para o inglês:\n\n_{pt}_",
  repeat: "🎙️ Ouça e repita mandando um áudio:\n\n*{en}*",
  say: "🎙️ Diga em inglês, mandando um áudio:\n\n_{pt}_",
  fix: "Qual frase está certa?\n_{pt}_\n\n{options}",
  falseFriend: "Cuidado com a pegadinha! O que *{word}* significa?",
  pair: "🎧 Qual palavra você ouviu? _({sound})_",
  chat: "💬 _{context}_\n\n{them}\n\nQual a melhor resposta?",
  mistake: "Na conversa você disse: _{said}_\nQual é o certo?",
  labelled: "{options}",
  right: ["✅ Isso!", "✅ Certo!", "✅ Mandou bem!", "✅ Perfeito!", "✅ Boa!"],
  almost: "✅ Certo! Só atenção à escrita: *{words}*",
  wrong: "❌ Quase. O certo é: *{answer}*",
  skipped: "👉 A resposta é: *{answer}*",
  spoken: "🎙️ *{score}/100*. Ouvi: _{heard}_",
  spokenWeak: "Treine: *{words}*",
  spokenRetry: "🎧 Não consegui ouvir bem. Pode gravar de novo, num lugar mais silencioso?",
  chooseHint: "Toque numa opção ou mande o número (1 a {n}). Para sair da aula: /sair",
  typeHint: "Aqui é para *escrever* a resposta ✍️ (ou toque em _Não sei_).",
  voiceHint: "Aqui é para mandar um *áudio* 🎙️ (ou toque em _Não sei_).",
  stale: "Esse botão é de um exercício que já passou. Continue no último 👇",
  paused: "⏸️ Aula pausada. Para continuar de onde parou: /aula",
  resumed: "▶️ Continuando a aula.",
  finished: "🏁 *Aula concluída!* {correct} de {total} certas · +{points} pontos",
  finishedNew: "Palavras novas: {words}",
  finishedDue: "Revisões esperando você: {n} (/revisar)",
  nothingToReview: "Nada para revisar agora 🎉 Que tal uma aula nova? /aula",
  dailyLimit:
    "Você já fez {n} aula(s) hoje, o limite do seu plano. Amanhã tem mais! " +
    "Enquanto isso, mande um áudio e vamos conversar 🙂",
  unavailable: "As aulas ainda não estão disponíveis. Mande um áudio e vamos conversar!",
  dontKnow: "🤷 Não sei",
  stop: "⏹️ Sair da aula",
  again: "▶️ Outra aula",
  review: "🔁 Revisar",
  menu: "☰ Menu",
  optionsButton: "Ver opções",
};

export const COURSE_EN: CourseTexts = {
  ...COURSE_PT,
  firstLesson:
    "📚 *Quick lesson*: 10 exercises with words, sentences, listening and speaking. Tap the " +
    "options, type, or send a voice message when I ask. To stop: /sair",
  lessonHeader: "*{n}/{total}*",
  reviewHeader: "*Review {n}/{total}*",
  meaning: "What does *{word}* mean?{example}",
  word: "How do you say *{pt}* in English?",
  listen: "🎧 Which word did you hear?",
  cloze: "Complete the sentence:\n\n*{sentence}*\n_{pt}_",
  type: "✍️ Write it in English: *{pt}*",
  order:
    "🧩 Build the sentence in English: _{pt}_\n\n{tiles}\n\nSend the numbers in order " +
    "(e.g. 3 1 2) or type the sentence.",
  dictation: "🎧 Type the sentence you heard.",
  translate: "✍️ Translate into English:\n\n_{pt}_",
  repeat: "🎙️ Listen and repeat with a voice message:\n\n*{en}*",
  say: "🎙️ Say it in English with a voice message:\n\n_{pt}_",
  fix: "Which sentence is correct?\n_{pt}_\n\n{options}",
  falseFriend: "Watch out, it's a trap! What does *{word}* mean?",
  pair: "🎧 Which word did you hear? _({sound})_",
  chat: "💬 _{context}_\n\n{them}\n\nWhat's the best reply?",
  mistake: "In our chat you said: _{said}_\nWhich one is correct?",
  right: ["✅ Yes!", "✅ Right!", "✅ Well done!", "✅ Perfect!", "✅ Nice!"],
  almost: "✅ Right! Just watch the spelling: *{words}*",
  wrong: "❌ Almost. The answer is: *{answer}*",
  skipped: "👉 The answer is: *{answer}*",
  spoken: "🎙️ *{score}/100*. I heard: _{heard}_",
  spokenWeak: "Practise: *{words}*",
  spokenRetry: "🎧 I couldn't hear it well. Could you record it again somewhere quieter?",
  chooseHint: "Tap an option or send its number (1 to {n}). To leave the lesson: /sair",
  typeHint: "This one is *typed* ✍️ (or tap _I don't know_).",
  voiceHint: "This one needs a *voice message* 🎙️ (or tap _I don't know_).",
  stale: "That button belongs to an earlier exercise. Keep going with the last one 👇",
  paused: "⏸️ Lesson paused. To pick up where you stopped: /aula",
  resumed: "▶️ Back to the lesson.",
  finished: "🏁 *Lesson complete!* {correct} of {total} right · +{points} points",
  finishedNew: "New words: {words}",
  finishedDue: "Reviews waiting for you: {n} (/revisar)",
  nothingToReview: "Nothing to review right now 🎉 How about a new lesson? /aula",
  dailyLimit:
    "You've done {n} lesson(s) today, your plan's limit. More tomorrow! Meanwhile, send me a " +
    "voice message and let's talk 🙂",
  unavailable: "Lessons are not available yet. Send me a voice message and let's talk!",
  dontKnow: "🤷 I don't know",
  stop: "⏹️ Leave lesson",
  again: "▶️ Another lesson",
  review: "🔁 Review",
  menu: "☰ Menu",
  optionsButton: "See options",
};

export function courseTexts(lang: string | null | undefined): CourseTexts {
  return lang === "pt" ? COURSE_PT : COURSE_EN;
}
