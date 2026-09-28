/**
 * The hybrid search query: pgvector (HNSW, cosine) + Postgres full-text, fused with Reciprocal
 * Rank Fusion, in ONE statement. Filters apply to both halves.
 *
 * RRF score = 1/(RRF_K + rank_vector) + 1/(RRF_K + rank_fulltext); a document found by only one
 * method gets only that term. RRF_K=60 is the value from the original RRF paper.
 *
 * Parameters: $1 collection, $2 topic, $3 levels, $4 user_id, $5 qvec, $6 tsquery,
 * $7 candidates per method, $8 k.
 */
export const RRF_K = 60;

const FILTERS = `
    collection = $1
    AND (CAST($2 AS text) IS NULL OR topic = $2 OR topic IS NULL)
    AND (CAST($3 AS text[]) IS NULL OR level IS NULL OR level = ANY($3))
    AND (user_id = $4 OR (CAST($4 AS integer) IS NULL AND user_id IS NULL))
`;

export const HYBRID_SEARCH = `
WITH vec AS (
    SELECT id, row_number() OVER (ORDER BY embedding <=> CAST($5 AS vector)) AS rank
    FROM documents
    WHERE ${FILTERS}
    ORDER BY embedding <=> CAST($5 AS vector)
    LIMIT $7
),
fts AS (
    SELECT id, row_number() OVER (ORDER BY ts_rank_cd(tsv, q) DESC) AS rank
    FROM documents, to_tsquery('english', $6) AS q
    WHERE ${FILTERS} AND $6 <> '' AND tsv @@ q
    ORDER BY ts_rank_cd(tsv, q) DESC
    LIMIT $7
)
SELECT d.collection, d.key, d.source, d.content, d.topic, d.level, d.kind, d.user_id,
       d.metadata,
       COALESCE(1.0 / (${RRF_K} + vec.rank), 0) + COALESCE(1.0 / (${RRF_K} + fts.rank), 0)
           AS score
FROM (SELECT id FROM vec UNION SELECT id FROM fts) AS hits
JOIN documents AS d USING (id)
LEFT JOIN vec USING (id)
LEFT JOIN fts USING (id)
ORDER BY score DESC
LIMIT $8
`;
