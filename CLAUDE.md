# saybest — convenções para agentes

Tutor de inglês pelo WhatsApp em TypeScript (Node 22). Visão geral e operação: `README.md`.

## Layout
```
src/config.ts        Settings (Zod, env UPPER_SNAKE)       src/logging.ts   pino, getLogger
src/domain/          lógica pura, sem I/O                  src/guardrails/  regras de entrada/saída, limites
src/accounts/        contas, telefones, senhas, códigos    src/ports/       interfaces (Cache, LLM, Channel...)
src/adapters/        implementações reais + fakes          src/graph/       LangGraph.js (nós em graph/nodes)
src/rag/             ingestão e busca híbrida (pgvector)   src/prompts/     PromptRegistry
src/api/             Hono: webhooks, API de admin          src/panel/       Hono + Nunjucks (templates/panel-ts)
src/worker/          BullMQ                                src/connections/ conexões WhatsApp (credenciais cifradas)
src/db/              Drizzle (schema, client, migrate)     src/container.ts escolhe as implementações
ops/                 backup.sh (pg_dump + Drive) e vigia.sh (alertas pela uazapi), rodam no host via cron
src/course/          aulas /aula: conteúdo, exercícios, correção, FSRS, motor
test/                Vitest, espelha src/; fixtures em test/fixtures; evals em test/*-eval.yaml
scripts/             migrate, ingest, create-admin, eval-conversations, download-models
drizzle/  migrações   prompts/  prompts JSON versionados   schemas/  JSON Schemas dos prompts
data/     temas + gramática (RAG); course/ (palavras, frases, pegadinhas)
templates/  evaluation.njk (card), fonts/ (Inter, OFL), panel-ts/ (painel, landing.html)
```

## Comandos
- Tipos: `npx tsc --noEmit`. Lint/formatação: `npx biome check --write .` (100 colunas, aspas duplas).
- Testes: `npx vitest run` (projetos `unit` e `integration`), `npm test` (só unit),
  `npx vitest run test/<arquivo>`. Integração usa o Postgres (banco `coach_test`) e o Redis (db 15)
  da stack em 127.0.0.1, um arquivo por vez.
- `npm run eval` chama o LLM real e gasta cota do OpenRouter: **pergunte ao usuário antes**.
  `npm run eval -- --fake-llm` não gasta nada.

## Estilo
- ESM com extensão `.js` nos imports (`import { x } from "./x.js"`), TS strict,
  `noUncheckedIndexedAccess`. Arquivos em kebab-case; identificadores em camelCase; constantes
  exportadas em UPPER_SNAKE.
- Nomes de campos que vão para o LLM, banco ou JSON **não mudam** (`score_breakdown`,
  `explanation`, `messages_per_day`): schemas e prompts dependem deles.
- Schemas Zod: `export const X = z.object({...}).strict()` + `export type X = z.infer<typeof X>`.
  As `description` viram o JSON Schema enviado ao modelo: trate-as como parte do prompt.
- Regex: `\b` só entende ASCII em JS; para palavras com acento use `\p{L}` com a flag `u`.
- Comentários poucos: o porquê e os casos reais que motivaram a regra.
- Sem dependências novas sem necessidade.

## Regras
- Prompts só em `prompts/*.json`, carregados pelo `PromptRegistry` (veja `prompts/CLAUDE.md`).
  Mudou o texto, suba a `version` (entra na chave do cache).
- `src/container.ts` é o único lugar que escolhe implementações (real ou fake). Toda interface de `src/ports/` tem fake.
- Testes nunca usam a rede: `test/setup.ts` bloqueia tudo fora de 127.0.0.1.
- Só modelos gratuitos por enquanto: decisão do usuário, não troque o `.env` para modelos pagos.
- Nunca imprima segredos (`.env`, chaves, tokens, senhas). O `create-admin` grava a senha em
  `out/panel_password.txt` (modo 600) e não a mostra.
- As regras de limpeza em `src/domain/evaluation.ts` têm a última palavra sobre o que o modelo
  devolve. Antes de mudá-las, adicione aos testes o caso real que falha.
- Aulas: a correção é por código (sem LLM). Conteúdo de `data/course/words.jsonl` e
  `sentences.jsonl` vem do `scripts/build-course.ts`: não edite à mão, mude o script.
  `traps.yaml` é escrito à mão: resposta certa sem ambiguidade, erradas claramente erradas.
- A Meta cobra cada mensagem enviada (desde 1º/10/2026): evite mensagens extras por turno.
- whisper.cpp: faixas de confiança `STT_MIN_CONFIDENCE=-2.0` (abaixo disso pede para repetir) e
  `STT_SURE_CONFIDENCE=-1.05` (acima disso avalia sem ressalva).
- Modelos (whisper.cpp, Kokoro, bge-small) ficam em `/opt/models` na imagem do worker
  (`MODELS_DIR`); o worker roda sem rede. Trocar modelo exige rebuild.

## Banco
- Migrações Drizzle em `drizzle/`: depois de editar `src/db/schema.ts`, rode
  `npx drizzle-kit generate`. A API aplica as migrações ao subir (`scripts/migrate.ts`).
- Bancos existentes criados por outra ferramenta são adotados automaticamente (`src/db/migrate.ts`).

## Infra
- Tudo em 127.0.0.1: api 8010, postgres 5433, redis 6380. Só `saybest-api` entra na rede externa
  `shared-net`; o nginx do host faz proxy só de `/webhooks/` e `/panel/`. API de admin só via `ssh -L`.
- Servidor: 3 CPUs, 7 GB de RAM, sem GPU. Threads de whisper/Kokoro fixas por isso.
