# prompts/

Um arquivo JSON por prompt, carregado e validado no boot pelo `PromptRegistry` (`src/prompts/registry.ts`; o formato do arquivo é o `PromptSpec` de `src/prompts/spec.ts`). Qualquer erro aqui derruba a inicialização, e não uma conversa no meio.

- O `id` é igual ao nome do arquivo. Suba a `version` (semver) ao mudar um texto: ela entra na chave do cache de LLM.
- `model_role` pode ser `evaluator`, `conversation` ou `guard`, e escolhe o modelo pela env (`LLM_MODEL_*`). O `summarize_history` e o `translate` usam `guard`, o modelo mais barato.
- `cache`: `false` só no `conversation_reply` e no `topic_opener`, para ter variedade.
- Os placeholders do `user_template` precisam ser exatamente os `input_variables`.
- **Toda** variável que o aluno ou o RAG consegue influenciar, inclusive o `topic` (definido por `/tema`), segue duas regras:
  - fica em `untrusted_variables`;
  - aparece sozinha dentro de uma tag (`<topic>\n{topic}\n</topic>`). O registry recusa o prompt se não estiver assim.

  Os `<`, `>` e parecidos (de largura total e CJK) dentro desses valores viram `‹ ›`, então nenhuma entrada consegue fechar uma tag.
- Só pode ficar fora das tags uma variável validada por whitelist no código. Hoje são o `level` (CEFR A1–C2), os idiomas do `translate` (`source_language`/`target_language`, valores do enum `Language` de `src/domain/translation.ts`), a `situation` do `topic_opener` (constantes de `SITUATIONS` em `src/graph/nodes/route-command.ts`) e o `tutor` (de `TUTORS` em `src/domain/tutors.ts`). Um teste em `test/prompts/registry.test.ts` garante isso.
- Os valores das variáveis precisam ser `string`. Listas e objetos são montados pelo chamador.
- `cache_ttl_s` (opcional) sobrescreve `CACHE_TTL_LLM_S`. O `guard_input` usa 1 h, para um veredito errado não ficar dias no cache.
- `output_schema` aponta para `schemas/*.json`. Cada arquivo é o `strictSchema(...)` (`src/prompts/schema.ts`) do modelo Zod correspondente em `src/domain/` (`Evaluation`, `Reply`, `HistorySummary`, `GuardResult`, `Translation`): todo objeto com `additionalProperties: false` e todas as propriedades em `required`; limites (min/max, tamanhos) ficam só no Zod, que valida a resposta depois da chamada. No boot o registry confere que o schema é um objeto estrito e valida os `examples` contra ele (Ajv). Na primeira chamada de cada prompt, o `OpenRouterLLM` compara o schema do arquivo com o `strictSchema` do modelo Zod passado e recusa a chamada (`PromptError`) se forem diferentes. Para mudar um schema, edite o modelo Zod e regrave o arquivo, por exemplo:

  ```sh
  npx tsx -e 'import { strictSchema } from "./src/prompts/schema.ts"; import { Evaluation } from "./src/domain/evaluation.ts"; console.log(JSON.stringify(strictSchema(Evaluation), null, 2))' > schemas/evaluation.schema.json
  ```

  Todo campo precisa de `description` (vai para o modelo).
- Os `examples` viram pares few-shot (user/assistant) e são validados contra o schema. Cada exemplo custa tokens em toda chamada, então use poucos.
- Testes: `npx vitest run test/prompts`. O `test/fixtures/prompts-parity.json` guarda a saída de referência de `render` para cada prompt; mudar um texto exige atualizar esse fixture.
- Depois de mudar um prompt, rode as conversas roteirizadas com o LLM real: `npm run eval -- -k <cenário>` (gasta cota do OpenRouter) e leia `out/eval/<timestamp>/report.md`.
