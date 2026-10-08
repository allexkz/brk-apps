-- BRK Personalizados — estado do pipeline Sankhya por pedido (substitui os mapas do KV
-- `personalizados:sankhya:<shop>` e `personalizados:nunotas:<shop>`, que cresciam com o
-- histórico e eram lidos/parseados inteiros a cada webhook, ciclo do dreno e acesso).
--
-- Tudo aqui é acessado por índice + LIMIT: custo por operação independe do histórico.
-- Banco próprio (binding PERSO_DB) — separado do D1 dos bundles.

CREATE TABLE IF NOT EXISTS perso_jobs (
  shop             TEXT    NOT NULL,
  legacy_id        TEXT    NOT NULL,          -- id numérico do pedido na Shopify
  name             TEXT,                      -- "#11535"
  order_created_at TEXT,                      -- ISO (quando conhecido)
  status           TEXT,                      -- pending|sent|error|seller|hold|done; NULL = só Nº/sem atributos (não ingerido)
  retry            INTEGER NOT NULL DEFAULT 0,-- 1 = na fila do envio automático
  next_try_at      TEXT,                      -- ISO: próxima tentativa (espera crescente)
  attempts         INTEGER NOT NULL DEFAULT 0,
  reason           TEXT,
  seller           TEXT,
  has_attrs        INTEGER NOT NULL DEFAULT 1,-- 0 = PE1198 sem atributos do modal
  perso_json       TEXT,                      -- personalizações enxutas (sku,tipo,nome,local,posicao)
  nunota           INTEGER,                   -- Nº Sankhya (NUNOTA)
  nunota_manual    INTEGER NOT NULL DEFAULT 0,
  written          INTEGER,
  manual           INTEGER NOT NULL DEFAULT 0,
  status_at        TEXT,                      -- quando entrou no status atual (= `at` do KV)
  updated_at       TEXT    NOT NULL,
  PRIMARY KEY (shop, legacy_id)
);

-- Fila do envio automático: WHERE shop=? AND retry=1 AND next_try_at<=? ORDER BY next_try_at LIMIT n
CREATE INDEX IF NOT EXISTS idx_perso_queue  ON perso_jobs (shop, retry, next_try_at);
-- "Presos" e listas por status
CREATE INDEX IF NOT EXISTS idx_perso_status ON perso_jobs (shop, status, status_at);
-- Busca por Nº Sankhya / checagem de duplicidade / "Atualizar Banco" (sem Nº)
CREATE INDEX IF NOT EXISTS idx_perso_nunota ON perso_jobs (shop, nunota);
-- Aba "Sem atributos"
CREATE INDEX IF NOT EXISTS idx_perso_attrs  ON perso_jobs (shop, has_attrs, legacy_id);

-- Contadores por status, mantidos INCREMENTALMENTE na mesma transação de cada mudança
-- de status (nunca COUNT sobre o histórico no caminho de uma request comum).
CREATE TABLE IF NOT EXISTS perso_counters (
  shop   TEXT    NOT NULL,
  status TEXT    NOT NULL,
  n      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (shop, status)
);

-- Os contadores são mantidos por TRIGGERS (mesma transação da escrita do pedido): não
-- dependem do código lembrar de somar/subtrair e não dessincronizam com escritas
-- concorrentes (webhook × dreno). status NULL não conta.
CREATE TRIGGER IF NOT EXISTS trg_perso_counter_ins
AFTER INSERT ON perso_jobs WHEN NEW.status IS NOT NULL
BEGIN
  INSERT INTO perso_counters (shop, status, n) VALUES (NEW.shop, NEW.status, 1)
    ON CONFLICT (shop, status) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_perso_counter_upd
AFTER UPDATE OF status ON perso_jobs WHEN OLD.status IS NOT NEW.status
BEGIN
  UPDATE perso_counters SET n = n - 1 WHERE shop = OLD.shop AND status = OLD.status;
  INSERT INTO perso_counters (shop, status, n)
    SELECT NEW.shop, NEW.status, 1 WHERE NEW.status IS NOT NULL
    ON CONFLICT (shop, status) DO UPDATE SET n = n + 1;
END;

CREATE TRIGGER IF NOT EXISTS trg_perso_counter_del
AFTER DELETE ON perso_jobs WHEN OLD.status IS NOT NULL
BEGIN
  UPDATE perso_counters SET n = n - 1 WHERE shop = OLD.shop AND status = OLD.status;
END;

-- Metadados (ex.: migração KV → D1 concluída).
CREATE TABLE IF NOT EXISTS perso_meta (
  shop  TEXT NOT NULL,
  key   TEXT NOT NULL,
  value TEXT,
  PRIMARY KEY (shop, key)
);
