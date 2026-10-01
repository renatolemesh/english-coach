#!/usr/bin/env bash
#
# Vigia do saybest: avisa pelo WhatsApp (uazapi, o canal de alerta deste servidor) quando o
# bot sai do ar ou começa a falhar. Mesmo desenho do vigia da coleta
# (/home/chatbot/chatbot/WebScrap/vigia/vigia-coleta.sh): checagens -> lista de problemas -> uma
# mensagem, com silêncio entre repetições. Diferenças: o silêncio vale por conjunto de problemas
# (um problema novo avisa na hora) e, quando tudo volta ao normal depois de um aviso, manda um
# "normalizado".
#
# Cron, a cada 5 minutos (DESTINO é o número que recebe; fica no crontab, fora do repositório):
#     */5 * * * * DESTINO=55DDDNUMERO /home/chatbot/chatbot/english-coach/ops/vigia.sh >> /var/log/saybest-vigia.log 2>&1
#
#     ops/vigia.sh --teste    manda uma mensagem de teste
#     ops/vigia.sh --resumo   só checa e imprime, não manda nada

set -uo pipefail

ESTADO_DIR="${ESTADO_DIR:-/var/tmp/saybest-vigia}"
ARQ_TOKEN="${ARQ_TOKEN:-/home/chatbot/chatbot/WebScrap/.uazapi-token}"
UAZAPI_URL="${UAZAPI_URL:-https://synapsea.uazapi.com/send/text}"
DESTINO="${DESTINO:-}"
API_LOCAL="${API_LOCAL:-http://127.0.0.1:8010/health}"
SITE="${SITE:-https://saybest.rlhtech.com.br/panel/login}"
CONTAINERS="${CONTAINERS:-saybest-api saybest-worker saybest-db saybest-redis}"
REDIS="${REDIS:-saybest-redis}"
FILA="${FILA:-bull:process_message}"
TOLERANCIA="${TOLERANCIA:-2}"          # rodadas seguidas com falha antes de avisar (2 = 10 min)
THROTTLE_MIN="${THROTTLE_MIN:-120}"    # mesmo conjunto de problemas: repete no máximo a cada 2 h
FILA_MAX="${FILA_MAX:-10}"             # mensagens esperando o worker
JANELA="${JANELA:-6m}"                 # logs olhados por rodada (cron de 5 min + folga)
ERROS_MAX="${ERROS_MAX:-3}"            # erros do worker na janela
LLM_FALHAS_MAX="${LLM_FALHAS_MAX:-3}"  # respostas prontas porque todos os modelos falharam
BACKUP_MAX_H="${BACKUP_MAX_H:-36}"

mkdir -p "$ESTADO_DIR"
log() { printf '%s %s\n' "$(date '+%Y-%m-%d %H:%M:%S')" "$*"; }

PROBLEMAS=()
CHAVES=()
anotar() { CHAVES+=("$1"); PROBLEMAS+=("$2"); }

json_str() { python3 -c 'import json,sys; print(json.dumps(sys.argv[1]))' "$1"; }

# Envia; só um 2xx conta como entregue (senão uma falha da uazapi silenciaria o alerta).
enviar() {
    local texto="$1"
    if [[ -z "$DESTINO" ]]; then
        log "[SEM DESTINO - não enviei] $texto"
        return 1
    fi
    if [[ ! -f "$ARQ_TOKEN" ]]; then
        log "[SEM TOKEN em $ARQ_TOKEN - não enviei] $texto"
        return 1
    fi
    local token resposta codigo
    token="$(tr -d '[:space:]' < "$ARQ_TOKEN")"
    resposta="$(curl -s --max-time 30 -X POST "$UAZAPI_URL" \
        -H 'Content-Type: application/json' \
        -H "token: $token" \
        --data-raw "$(printf '{"number":"%s","text":%s}' "$DESTINO" "$(json_str "$texto")")" \
        -w '\n%{http_code}')" || { log "ERRO: falha ao chamar a uazapi"; return 1; }
    codigo="${resposta##*$'\n'}"
    if [[ "$codigo" == 2* ]]; then
        log "[enviado]"
        return 0
    fi
    log "ERRO: uazapi respondeu $codigo"
    return 1
}

# Conta falhas seguidas de uma checagem; verdadeiro quando chegou à tolerância.
persistiu() {
    local chave="$1" ok="$2" arq="$ESTADO_DIR/$1.falhas"
    if [[ "$ok" == "sim" ]]; then
        rm -f "$arq"
        return 1
    fi
    local n=1
    [[ -f "$arq" ]] && n=$(( $(cat "$arq") + 1 ))
    echo "$n" > "$arq"
    log "$chave falhou ($n/$TOLERANCIA)"
    (( n >= TOLERANCIA ))
}

checar_containers() {
    local c parados=()
    for c in $CONTAINERS; do
        docker ps --filter "name=^${c}$" --filter 'status=running' --format '{{.Names}}' \
            2>/dev/null | grep -q . || parados+=("$c")
    done
    local ok='sim'
    (( ${#parados[@]} )) && ok='nao'
    if persistiu 'containers' "$ok"; then
        anotar containers "Container parado: ${parados[*]}. O bot não responde. Conferir: cd /home/chatbot/chatbot/english-coach && docker compose ps"
    fi
}

checar_api() {
    local corpo ok='sim'
    corpo="$(curl -s --max-time 15 "$API_LOCAL" 2>/dev/null)"
    [[ "$corpo" == *'"status":"ok"'* && "$corpo" != *'"redis":"down"'* ]] || ok='nao'
    if persistiu 'api' "$ok"; then
        anotar api "A API não responde bem em $API_LOCAL (resposta: ${corpo:-nenhuma}). Webhooks da Meta podem estar se perdendo."
    fi
}

checar_site() {
    local codigo ok='sim'
    codigo="$(curl -s -o /dev/null -w '%{http_code}' --max-time 20 "$SITE" 2>/dev/null)"
    [[ "$codigo" == '200' ]] || ok='nao'
    if persistiu 'site' "$ok"; then
        anotar site "O endereço público não responde ($SITE: HTTP ${codigo:-sem resposta}). Nginx, certificado ou rede: a Meta não entrega mensagens."
    fi
}

# O worker do BullMQ renova esta chave a cada 30 s enquanto está vivo e processando a fila.
checar_worker() {
    local vivo esperando ok='sim'
    vivo="$(docker exec "$REDIS" redis-cli exists "$FILA:stalled-check" 2>/dev/null | tr -d '[:space:]')"
    esperando="$(docker exec "$REDIS" redis-cli llen "$FILA:wait" 2>/dev/null | tr -d '[:space:]')"
    [[ "$vivo" == '1' ]] || ok='nao'
    [[ "${esperando:-0}" =~ ^[0-9]+$ ]] && (( esperando > FILA_MAX )) && ok='nao'
    if persistiu 'worker' "$ok"; then
        anotar worker "O worker não está processando (vivo=${vivo:-?}, mensagens esperando=${esperando:-?}). Alunos sem resposta. Conferir: docker logs --tail 50 saybest-worker"
    fi
}

checar_erros() {
    local logs erros llm resumo
    logs="$(docker logs --since "$JANELA" saybest-worker 2>&1)"
    erros="$(grep -c '"level":"error"' <<< "$logs")"
    llm="$(grep -c '"event":"llm_fallback"' <<< "$logs")"
    if (( erros >= ERROS_MAX )); then
        resumo="$(grep '"level":"error"' <<< "$logs" | grep -o '"event":"[^"]*"' | sort | uniq -c \
            | sort -rn | head -3 | sed -E 's/ *([0-9]+) "event":"([^"]*)"/\2 (\1x)/' \
            | awk '{printf "%s%s", (NR > 1 ? ", " : ""), $0}')"
        anotar erros "$erros erros no worker nos últimos ${JANELA}: ${resumo:-sem detalhe}. Conferir: docker logs --since 30m saybest-worker | grep error"
    fi
    if (( llm >= LLM_FALHAS_MAX )); then
        anotar llm "$llm respostas prontas nos últimos ${JANELA} porque todos os modelos do OpenRouter falharam (cota grátis esgotada ou modelos fora do ar)."
    fi
}

checar_backup() {
    local arq="$ESTADO_DIR/backup.estado" epoch estado idade_h
    if [[ ! -f "$arq" ]]; then
        anotar backup "O backup do banco nunca rodou (sem $arq). Conferir o cron de ops/backup.sh."
        return
    fi
    read -r epoch estado _ < "$arq"
    idade_h=$(( ($(date +%s) - epoch) / 3600 ))
    if [[ "$estado" != 'ok' ]]; then
        anotar backup "O último backup do banco falhou. Conferir /var/log/saybest-backup.log."
    elif (( idade_h >= BACKUP_MAX_H )); then
        anotar backup "Último backup do banco foi há ${idade_h}h (deveria ser diário). Conferir o cron e /var/log/saybest-backup.log."
    fi
}

case "${1:-}" in
    --teste)
        enviar "Vigia do saybest instalado em $(hostname). Esta é uma mensagem de teste."
        exit $?
        ;;
    --resumo)
        SO_RESUMO=1
        ;;
esac

checar_containers
checar_api
checar_site
checar_worker
checar_erros
checar_backup

ULTIMO="$ESTADO_DIR/aviso.ultimo"   # conjunto de problemas do último aviso enviado
if (( ${#PROBLEMAS[@]} == 0 )); then
    log 'tudo certo'
    if [[ -f "$ULTIMO" && -z "${SO_RESUMO:-}" ]]; then
        enviar "✅ saybest normalizado: $(cat "$ULTIMO") não aparece mais." && rm -f "$ULTIMO"
    fi
    exit 0
fi

for p in "${PROBLEMAS[@]}"; do log "PROBLEMA: $p"; done
[[ -n "${SO_RESUMO:-}" ]] && exit 1

assinatura="$(printf '%s\n' "${CHAVES[@]}" | sort -u | paste -sd ',')"
if [[ -f "$ULTIMO" && "$(cat "$ULTIMO")" == "$assinatura" ]]; then
    idade=$(( ($(date +%s) - $(stat -c %Y "$ULTIMO")) / 60 ))
    if (( idade < THROTTLE_MIN )); then
        log "[silenciado ${idade}/${THROTTLE_MIN}min] $assinatura"
        exit 1
    fi
fi
mensagem="⚠️ saybest com problema:"
for p in "${PROBLEMAS[@]}"; do
    mensagem+=$'\n\n- '"$p"
done
enviar "$mensagem" && echo "$assinatura" > "$ULTIMO"
exit 1
