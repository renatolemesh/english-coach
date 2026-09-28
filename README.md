# saybest

Tutor de conversação em inglês pelo WhatsApp. MVP em TypeScript (Node 22).

## Como funciona

1. O aluno manda um **áudio** (ou texto) em inglês.
2. Recebe uma **imagem** com as correções e uma nota de 0 a 100.
3. Em seguida recebe um **voice note** do tutor, que continua a conversa, com os botões
   **Transcrever**, **Traduzir** e **Menu** (na Evolution: `/transcrever`, `/traduzir`, `/menu`).
4. `/menu` troca tema, nível, voz (Sarah, padrão; Emma, George, Michael), velocidade da fala e
   idioma das mensagens (inglês, recomendado, ou português).
5. Memória da conversa: últimos 10 turnos + um resumo. Se o estado se perder, é reconstruído a
   partir da tabela `turns`.

```
WhatsApp ─▶ nginx (/webhooks/) ─▶ api (Hono) ─▶ Redis (BullMQ) ─▶ worker (LangGraph.js)
                                                                      │
   STT (whisper.cpp) · guardrails · RAG (pgvector) · LLM (OpenRouter) · card (Chromium) · voz (Kokoro)
                                                                      │
                                              ◀── resposta pelo mesmo provedor
```

Stack: Hono, Drizzle + Postgres 17/pgvector, ioredis + BullMQ, LangGraph.js, OpenRouter via
`fetch` (json_schema strict, retries, modelos reserva, cache), whisper.cpp (`small.en` q8_0 +
Silero VAD), kokoro-js, embeddings locais com transformers.js (`Xenova/bge-small-en-v1.5`, 384
dims), Playwright/Chromium para o card, pino, Biome, Vitest.

Tudo roda em Docker e escuta em `127.0.0.1` (api 8010, postgres 5433, redis 6380). O nginx do
host faz proxy só de `/webhooks/` e `/panel/` para `saybest-api:8000` pela rede `shared-net`.
A API de admin só é acessível por `ssh -L`.

## Configuração

```bash
cp .env.example .env
```

Preencha no `.env`:

| variável | valor |
|---|---|
| `POSTGRES_PASSWORD` (e o mesmo em `DATABASE_URL`) | uma senha forte |
| `OPENROUTER_API_KEY` | https://openrouter.ai/keys |
| `FERNET_KEY` | `node -e "console.log(require('crypto').randomBytes(32).toString('base64url'))"` |
| `ADMIN_API_KEY` | o mesmo comando (outro valor) |
| `PUBLIC_BASE_URL` | `https://<seu-dominio>` |

A `FERNET_KEY` cifra as credenciais das conexões: se mudar, as conexões salvas deixam de abrir.
Sem `ADMIN_API_KEY`, a API de admin responde 503.

## Subir

```bash
npm ci                                           # para os scripts do host
docker compose up -d --build                     # db, redis, api, worker
curl 127.0.0.1:8010/health                       # {"status":"ok","redis":"ok"}
docker compose exec worker npx tsx scripts/ingest.ts   # conteúdo do RAG (idempotente)
```

A API aplica as migrações e sobe em ~12 s. O worker já traz os modelos na imagem e roda sem rede.

## Primeiro admin

```bash
npx tsx scripts/create-admin.ts --email voce@exemplo.com --name Voce   # --role staff para equipe
```

A senha temporária vai para `out/panel_password.txt` (modo 600) e não é impressa; troque-a no
primeiro login em `https://<dominio>/panel/admin/login`.

## Conectar o WhatsApp

Cada conexão tem `provider` (`meta` ou `evolution`), credenciais cifradas, um `webhook_secret` e
`settings`. A URL de webhook é `https://<dominio>/webhooks/<id>`.

```bash
ssh -L 8010:127.0.0.1:8010 <servidor>           # na sua máquina
K='<ADMIN_API_KEY>'

# Meta Cloud API
curl -s localhost:8010/admin/connections -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "id": "meta-main", "name": "WhatsApp oficial", "provider": "meta",
  "credentials": {"access_token": "<token de system user>", "app_secret": "<app secret>",
                  "verify_token": "<string aleatória>"},
  "settings": {"phone_number_id": "<id do número>"}}'

# Evolution API v2
curl -s localhost:8010/admin/connections -H "x-api-key: $K" -H 'content-type: application/json' -d '{
  "id": "evo-main", "name": "Evolution", "provider": "evolution",
  "webhook_secret": "<segredo aleatório>",
  "credentials": {"api_key": "<token da instância>"},
  "settings": {"base_url": "http://evolution_api:8080", "instance": "coach"}}'
```

Outras rotas (todas com `x-api-key`): `GET /admin/connections` (lista, sem segredos),
`GET|PATCH /admin/connections/<id>` (PATCH mescla credenciais e settings),
`POST /admin/connections/<id>/enable|disable` e `POST /admin/connections/<id>/test` com
`{"to": "5541999990000"}`. `id` e `provider` não mudam; campos desconhecidos dão 422.

- **Meta:** no painel do app, Callback URL `https://<dominio>/webhooks/meta-main`, o mesmo verify
  token, e assine o campo `messages`.
- **Evolution:** configure o webhook da instância (`POST /webhook/set/<instancia>`) com a URL
  acima, header `x-webhook-secret: <webhook_secret>`, `base64: false` e o evento
  `MESSAGES_UPSERT`. O worker precisa alcançar o `base_url`.

Alternativa: `CONNECTIONS_FILE=connections.yaml` (modelo em `connections.example.yaml`, aceita
`${VAR}` do `.env`). O arquivo é regravado no banco a cada boot da API; gerencie cada conexão
**ou** pelo YAML **ou** pela API.

## Painel e contas

`https://<dominio>/panel/`:

- **Aluno:** cadastro em `/panel/signup` cria uma conta no plano Teste Ilimitado (30 dias sem
  limite), que depois vira o Grátis (15 mensagens por dia, só a voz da Sarah e as velocidades
  1,0x e 0,9x). Para confirmar o telefone, o aluno manda `ATIVAR <código>` para o WhatsApp do
  bot. No painel acompanha o progresso, a meta diária, o caminho para o próximo nível e o
  ranking da semana, e ajusta as preferências.
- **Equipe** (`/panel/admin`, papéis admin e staff): alunos, planos, conexões, configurações,
  usuários e auditoria.

Os planos ficam na tabela `plans` e são editados no painel: mensagens por dia, duração, vozes e
velocidades oferecidas e o plano seguinte quando o prazo acaba (ainda sem pagamento). O aviso de
limite diário vai uma vez por dia. Números desconhecidos recebem o link de cadastro (política
editável no painel).

Metas (`src/domain/progress.ts`): meta diária de 3, 5 ou 10 práticas (`/meta`), subida de nível
CEFR após N respostas com nota 75+ no nível atual, e pontos semanais para o ranking (segunda a
domingo, só primeiro nome e inicial; o aluno pode sair nas configurações).

## Testes e qualidade

```bash
npm test                     # unitários (sem rede)
npm run test:integration     # precisa da stack de pé: banco coach_test e Redis db 15 em 127.0.0.1
npx vitest run               # os dois
npx tsc --noEmit && npx biome check --write .
npm run eval -- --fake-llm   # conversas roteirizadas sem gastar cota
npm run eval                 # com o LLM real: gasta a cota grátis do OpenRouter
```

## Migrações

Drizzle em `drizzle/`. Depois de editar `src/db/schema.ts`: `npx drizzle-kit generate`. A API
aplica ao subir; manualmente: `npx tsx scripts/migrate.ts`. Bancos existentes são adotados
automaticamente (`src/db/migrate.ts`).

## Operação

- Logs JSON: `docker compose logs -f worker` (cada turno termina com `turn_done`).
- Mensagens recebidas: tabela `webhook_events` (status e erro).
- Webhook 401: secret ou assinatura errados. 404: conexão inexistente ou desativada.

Guia para agentes de código: `CLAUDE.md`.
