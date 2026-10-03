# Multicanal: WhatsApp (oficial e Evolution), Telegram e app

Objetivo: o mesmo aluno, com o mesmo progresso, plano, metas e conversa, em vários canais. O
WhatsApp oficial (que cobra cada mensagem desde 1º/10/2026) fica como porta de entrada e
lembretes; o uso pesado vai para canais sem custo por mensagem.

Há dois tipos de front end:

- **Canais de chat** (WhatsApp oficial, Evolution, Telegram): o bot empurra mensagens. Cada um é
  um adaptador da porta `ChatChannel` e declara o que suporta.
- **App** (Flutter: Android, iOS e web): um cliente da API `/app/v1`. Para o núcleo ele também é
  um canal (`AppChannel`), mas em vez de mandar mensagens grava eventos numa caixa de saída que o
  app busca, e recebe a avaliação estruturada (sem gerar o PNG no Chromium).

O núcleo (grafo da conversa, motor das aulas, metas, ranking, lembretes) não sabe qual canal é.

## Etapa 1: núcleo separado dos canais

1. **Porta `ChatChannel`** (antes `WhatsAppChannel`), com `capabilities`:
   `{ maxButtons, lists, voice, cards, structured }`. Os adaptadores traduzem uma `Choice`
   (corpo, opções, texto de reserva) para o que o canal tem: botões do WhatsApp (até 3), lista
   (até 10), teclado inline do Telegram, botões no app.
2. **Avaliação por canal**: `sendEvaluation(to, evaluation, png)` opcional. Canais com `cards`
   recebem o PNG; o app recebe o JSON (o nó `render_image` não roda para ele).
3. **Conta única, várias identidades**: tabela `student_identities (connection_id, address,
   student_id)`, única por `(connection_id, address)`. `address` é o telefone no WhatsApp, o chat
   id no Telegram, o id do aluno no app. A migração cria uma identidade para cada aluno atual. O
   `students.phone` continua sendo o telefone do aluno (login do painel).
4. **Conversa por aluno**: a memória do LangGraph passa de `conexão:telefone` para `student:<id>`
   (quem troca de canal continua a mesma conversa; a memória atual é reconstruída da tabela
   `turns`, como já acontece quando o estado se perde). Trava por aluno no runner.
5. **Último canal**: cada mensagem grava em `students` a conexão e o endereço de onde veio; os
   lembretes vão para lá.

## Etapa 2: Telegram

- Provedor `telegram`: credencial `bot_token`; `webhook_secret` vai no `setWebhook` e volta no
  cabeçalho `X-Telegram-Bot-Api-Secret-Token`.
- Entrada: texto, voz (`getFile` + download; já é OGG/Opus), toque em botão (`callback_query`,
  respondido com `answerCallbackQuery`; o `data` é o id da opção, como no WhatsApp).
- Saída: `sendMessage` (HTML: `*x*` vira `<b>x</b>`, `_x_` vira `<i>x</i>`), `sendPhoto`,
  `sendVoice`, teclado inline (uma opção por linha).
- Entrar: link `t.me/<bot>?start=<código>`. O cadastro no site mostra, além do `ATIVAR` do
  WhatsApp, o botão "Abrir no Telegram"; o painel do aluno ganha "Conectar Telegram" (vincula a
  conta existente). O bot recebe `/start <código>`. Sem telefone no Telegram, o código (secreto,
  de vida curta, gerado na sessão do navegador) é a prova.
- `scripts/telegram-setup.ts` registra o webhook. Precisa de um bot criado no @BotFather (token).
- Sem janela de 24 h nem custo: lembretes no Telegram podem ser mais livres (decidir depois).

## Etapa 3: API do app e app Flutter

API em `/app/v1` (Hono, mesmo container da API; nginx passa `/app/`):

| Método | Rota | O quê |
|---|---|---|
| POST | `/auth/login` | telefone + senha (as do painel) -> token (opaco, guardado com hash) |
| POST | `/auth/logout` | revoga o token |
| GET | `/me` | perfil, plano, metas, progresso, nível |
| PATCH | `/me/settings` | nível, voz, velocidade, idioma, meta, lembretes |
| GET | `/ranking` | ranking da semana |
| POST | `/messages` | texto ou áudio (multipart); entra na fila como qualquer mensagem |
| GET | `/events?after=<id>` | long-poll (até 25 s): texto, avaliação, voz, escolhas |
| GET | `/media/<id>` | áudio e imagens dos eventos |

- `AppChannel`: `send*` grava eventos (tabela `app_events`); a mídia vai para um armazenamento
  com prazo. Um toque num botão do app manda o id da opção, como nos outros canais, então aulas,
  teste de nível e menus funcionam sem código novo no núcleo.
- App Flutter (`app/`): login, conversa (gravar e ouvir áudio, card da avaliação nativo, botões),
  progresso. Começa pela versão web (servida em `/app/`), que não depende das lojas; Android e
  iOS saem do mesmo código (builds fora deste servidor: o Android precisa do SDK do Android, o iOS
  de um Mac).
- Lojas: Apple US$ 99/ano, Google US$ 25 uma vez; assinatura dentro do app pode exigir o
  pagamento da loja (verificar a regra atual para o Brasil). A versão web pode cobrar por Pix.

## Fora destas etapas

Pagamento, limites diferentes por canal, push notifications no app, aula em WhatsApp Flow.
