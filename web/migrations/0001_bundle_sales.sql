-- BRK Bundles — tracking de vendas (append-only).
-- 1 linha por (bundle presente em um pedido). Se um pedido tiver 2-3 bundles,
-- gera 2-3 linhas. UNIQUE torna o INSERT idempotente contra reentrega de webhook.

CREATE TABLE IF NOT EXISTS bundle_sales (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  shop           TEXT    NOT NULL,
  bundle_id      TEXT    NOT NULL,
  order_id       TEXT    NOT NULL,
  order_name     TEXT,
  variant_id     TEXT,
  quantity       INTEGER NOT NULL DEFAULT 1,
  gross_cents    INTEGER NOT NULL DEFAULT 0,   -- preço cheio do add-on * quantidade
  discount_cents INTEGER NOT NULL DEFAULT 0,   -- desconto aplicado (brinde => = gross)
  net_cents      INTEGER NOT NULL DEFAULT 0,   -- gross - discount (brinde => 0)
  mode           TEXT,                         -- gift | percent | fixed
  created_at     TEXT    NOT NULL              -- ISO 8601 do pedido (created_at do order)
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_bundle_sale
  ON bundle_sales (shop, order_id, bundle_id, variant_id);

CREATE INDEX IF NOT EXISTS idx_bundle_created
  ON bundle_sales (shop, bundle_id, created_at);
