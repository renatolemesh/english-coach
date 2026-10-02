/**
 * Fixed texts of the course mode (/aula). Always Portuguese, whatever /idioma says: meanings,
 * tips and translations are Portuguese (the course is for Brazilian learners), and English
 * instructions around them made the exercises read half in each language.
 * Templates use `{name}` placeholders (domain/texts formatText).
 */

export interface CourseTexts {
  readonly firstLesson: string; // shown above the first exercise ever
  readonly lessonHeader: string; // {n} {total}
  readonly reviewHeader: string; // {n} {total}
  readonly meaning: string; // {word}
  readonly example: string; // under the question: {en}
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
  readonly mistake: string; // {sentence}: the correction with a gap, in the student's sentence
  readonly mistakeOrder: string; // {tiles}
  readonly mistakeWord: string; // {said}: a Portuguese word in the English
  readonly mistakeSaid: string; // {said}: in the feedback
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
  // placement test (/teste)
  readonly placementOffer: string; // right after signup
  readonly placementGo: string; // button
  readonly placementSkip: string; // button
  readonly placementIntro: string; // above the first question
  readonly placementHeader: string; // {n}
  readonly placementResult: string; // {level} {name} {blocks}
  readonly placementTop: string; // passed the highest level tested: {next}
  readonly placementTalk: string; // button
  readonly placementLesson: string; // button
}

export const COURSE_PT: CourseTexts = {
  firstLesson:
    "📚 *Aula rápida*: 10 exercícios de palavras, frases, escuta e fala. Toque nas opções, " +
    "escreva ou mande áudio quando eu pedir. Para parar: /sair",
  lessonHeader: "*{n}/{total}*",
  reviewHeader: "*Revisão {n}/{total}*",
  meaning: "O que *{word}* significa?",
  example: "Exemplo: _{en}_",
  word: "Como se diz *{pt}* em inglês?",
  listen: "🎧 Qual palavra você ouviu?",
  cloze: "Complete a frase em inglês:\n\n*{sentence}*\n\nTradução: _{pt}_",
  type: "✍️ Escreva em inglês: *{pt}*",
  order:
    "🧩 Monte a frase em inglês: _{pt}_\n\n{tiles}\n\nMande os números na ordem (ex.: 3 1 2) ou escreva a frase.",
  dictation: "🎧 Escreva em inglês a frase que você ouviu.",
  translate: "✍️ Traduza para o inglês:\n\n_{pt}_",
  repeat: "🎙️ Ouça e repita mandando um áudio:\n\n*{en}*",
  say: "🎙️ Diga em inglês, mandando um áudio:\n\n_{pt}_",
  fix: "Qual é o jeito certo de dizer em inglês?\n_{pt}_\n\n{options}",
  falseFriend: "⚠️ Pegadinha! O que *{word}* significa em inglês?",
  pair: "🎧 Qual palavra você ouviu? _({sound})_",
  chat: "💬 Situação: _{context}_\n\n{them}\n\nQual a melhor resposta?",
  mistake: "💬 *Da sua conversa*: complete do jeito certo.\n\n*{sentence}*",
  mistakeOrder:
    "💬 *Da sua conversa*: monte a frase na ordem certa.\n\n{tiles}\n\n" +
    "Mande os números na ordem (ex.: 3 1 2) ou escreva a frase.",
  mistakeWord: "💬 *Da sua conversa*: você usou *{said}*. Como se diz em inglês?",
  mistakeSaid: "Na conversa você disse: _{said}_",
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
  placementOffer:
    "👋 Boas-vindas ao *saybest*!\n\nAntes da primeira conversa, quer descobrir seu nível de " +
    "inglês? São perguntas rápidas de tocar no botão (uns 2 minutos), e as conversas e as aulas " +
    "já começam no ponto certo.",
  placementGo: "📝 Fazer o teste",
  placementSkip: "⏭️ Pular",
  placementIntro:
    "📝 *Teste de nível*: perguntas de vocabulário e gramática que ficam mais difíceis ou mais " +
    "fáceis conforme você responde. Se não souber, escreva *não sei*: chutar atrapalha o resultado.",
  placementHeader: "*Teste de nível · {n}*",
  placementResult:
    "🎓 *Seu nível: {level}* ({name})\n{blocks}\n\nAjustei as conversas e as aulas para esse " +
    "nível. Se ficar fácil ou difícil demais, é só mudar: /nivel",
  placementTop:
    "Você foi bem até o nível mais alto do teste. Quer conversas mais puxadas? /nivel {next}",
  placementTalk: "🎙️ Conversar",
  placementLesson: "📚 Aula rápida",
};
