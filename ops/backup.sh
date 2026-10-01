#!/usr/bin/env bash
#
# Backup diário do saybest: banco (pg_dump) + configurações, local e no Google Drive.
#
# Mesmo desenho do backup do WebScrap (/home/chatbot/chatbot/WebScrap/operacao/backup.sh):
# dump -> verificação -> cópia local -> `rclone copy` -> rodízio dos dois lados -> arquivo de
# estado que o vigia (ops/vigia.sh) confere.
#
# Cron (o host está em Europe/Berlin; 07:30 de Berlim = 02:30 de Brasília):
#     30 7 * * * /home/chatbot/chatbot/english-coach/ops/backup.sh >> /var/log/saybest-backup.log 2>&1
#
# Restaurar:
#     docker exec -i saybest-db pg_restore -U coach -d coach --clean --if-exists < saybest_<data>.dump

set -uo pipefail

DATE="$(date +%Y-%m-%d)"
AQUI="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJETO="$(dirname "$AQUI")"

BASE_DIR="${BASE_DIR:-/home/chatbot/backups/saybest}"
RETENTION_DAYS="${RETENTION_DAYS:-14}"
GDRIVE_REMOTE="${GDRIVE_REMOTE:-gdrive:saybest-backups}"
CONTAINER_DB="${CONTAINER_DB:-saybest-db}"
ESTADO_DIR="${ESTADO_DIR:-/var/tmp/saybest-vigia}"
# Um dump menor que isto está truncado ou vazio. O banco de hoje (out/2026) dá ~400 KB.
MINIMO_BYTES="${MINIMO_BYTES:-100000}"

FALHAS=0
mkdir -p "$BASE_DIR/banco" "$BASE_DIR/configs" "$ESTADO_DIR"
echo "=== Backup saybest iniciado: $(date '+%Y-%m-%d %H:%M:%S') ==="

dump_banco() {
    local destino="$BASE_DIR/banco/saybest_$DATE.dump"
    local parcial="$destino.parcial"
    if ! docker ps --format '{{.Names}}' | grep -qx "$CONTAINER_DB"; then
        echo "  ERRO: container '$CONTAINER_DB' não está rodando - sem dump" >&2
        FALHAS=$((FALHAS + 1))
        return 1
    fi
    echo "  banco: $CONTAINER_DB -> $(basename "$destino")"
    # Formato custom (-Fc): já comprimido e restaurável tabela a tabela com pg_restore.
    if ! docker exec "$CONTAINER_DB" sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' \
        > "$parcial" 2> "$BASE_DIR/dump.err"; then
        echo "  ERRO: pg_dump falhou:" >&2
        sed 's/^/    /' "$BASE_DIR/dump.err" >&2
        rm -f "$parcial"
        FALHAS=$((FALHAS + 1))
        return 1
    fi
    rm -f "$BASE_DIR/dump.err"
    # O índice do arquivo precisa ler inteiro e listar a tabela de alunos: pega dump truncado.
    if ! docker exec -i "$CONTAINER_DB" pg_restore --list < "$parcial" 2>/dev/null \
        | grep -q 'TABLE DATA public students '; then
        echo "  ERRO: o dump não abre no pg_restore ou não tem a tabela students - descartando" >&2
        rm -f "$parcial"
        FALHAS=$((FALHAS + 1))
        return 1
    fi
    local tamanho
    tamanho="$(stat -c %s "$parcial")"
    if (( tamanho < MINIMO_BYTES )); then
        echo "  ERRO: dump com apenas $tamanho bytes (mínimo $MINIMO_BYTES)" >&2
        rm -f "$parcial"
        FALHAS=$((FALHAS + 1))
        return 1
    fi
    mv "$parcial" "$destino"
    chmod 600 "$destino"
    echo "  banco: OK, $(numfmt --to=iec "$tamanho" 2>/dev/null || echo "$tamanho B")"
}

backup_configs() {
    # .env (segredos), compose e conexões: sem eles o dump não sobe de novo.
    local destino="$BASE_DIR/configs/configs_$DATE.tar.gz"
    local arquivos=()
    for f in .env docker-compose.yml connections.yaml; do
        [[ -f "$PROJETO/$f" ]] && arquivos+=("$f")
    done
    if tar -czf "$destino" -C "$PROJETO" "${arquivos[@]}" \
        && git -C "$PROJETO" log --oneline -1 > "$BASE_DIR/configs/git_head_$DATE.txt"; then
        chmod 600 "$destino"
        echo "  configs: ${arquivos[*]}"
    else
        echo "  ERRO ao empacotar as configurações" >&2
        FALHAS=$((FALHAS + 1))
    fi
}

dump_banco
backup_configs

echo "Rodízio local (mais de $RETENTION_DAYS dias)..."
find "$BASE_DIR" -type f -mtime +"$RETENTION_DAYS" -delete

if ! command -v rclone >/dev/null; then
    echo "AVISO: rclone não instalado - backup existe SÓ neste disco." >&2
    FALHAS=$((FALHAS + 1))
else
    echo "Enviando para o Drive ($GDRIVE_REMOTE)..."
    if rclone copy "$BASE_DIR" "$GDRIVE_REMOTE" --exclude '*.parcial' --exclude 'dump.err'; then
        rclone delete "$GDRIVE_REMOTE" --min-age "${RETENTION_DAYS}d" --drive-use-trash=false
        rclone rmdirs "$GDRIVE_REMOTE" --leave-root 2>/dev/null || true
    else
        echo "ERRO: falha ao enviar para o Drive" >&2
        FALHAS=$((FALHAS + 1))
    fi
fi

if (( FALHAS == 0 )); then
    printf '%s ok\n' "$(date +%s)" > "$ESTADO_DIR/backup.estado"
    echo "=== Backup saybest concluído ==="
else
    printf '%s erro falhas=%s\n' "$(date +%s)" "$FALHAS" > "$ESTADO_DIR/backup.estado"
    echo "=== Backup saybest terminou com $FALHAS falha(s) ===" >&2
fi
exit "$FALHAS"
