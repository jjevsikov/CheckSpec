-- CheckSpec SQLite Demo Server — seed data
-- Executed in-memory at server startup by the server's database initialiser.
-- Uses standard SQLite DDL; loaded by sql.js (WebAssembly).

-- ── Users ─────────────────────────────────────────────────────────────────────
CREATE TABLE users (
  id    INTEGER PRIMARY KEY,
  name  TEXT    NOT NULL,
  email TEXT    NOT NULL UNIQUE,
  role  TEXT    NOT NULL DEFAULT 'user'
);

INSERT INTO users (id, name, email, role) VALUES
  (1, 'Alice',   'alice@example.com',   'admin'),
  (2, 'Bob',     'bob@example.com',     'user'),
  (3, 'Charlie', 'charlie@example.com', 'user'),
  (4, 'Diana',   'diana@example.com',   'moderator');

-- ── Products ──────────────────────────────────────────────────────────────────
CREATE TABLE products (
  id       INTEGER PRIMARY KEY,
  name     TEXT    NOT NULL,
  price    REAL    NOT NULL,
  category TEXT    NOT NULL,
  in_stock INTEGER NOT NULL DEFAULT 1   -- 1 = in stock, 0 = out of stock
);

INSERT INTO products (id, name, price, category, in_stock) VALUES
  (1, 'Widget',      9.99,  'hardware',  1),
  (2, 'Gadget',     29.99,  'hardware',  1),
  (3, 'Doohickey',   4.99,  'hardware',  0),
  (4, 'ThingamaBob', 14.99, 'accessory', 1),
  (5, 'Whatsit',     2.49,  'accessory', 1);

-- ── Orders ────────────────────────────────────────────────────────────────────
CREATE TABLE orders (
  id         INTEGER PRIMARY KEY,
  user_id    INTEGER NOT NULL REFERENCES users(id),
  product_id INTEGER NOT NULL REFERENCES products(id),
  quantity   INTEGER NOT NULL DEFAULT 1,
  ordered_at TEXT    NOT NULL            -- ISO-8601 timestamp (stored as TEXT)
);

-- Explicit timestamps make test results deterministic
INSERT INTO orders (id, user_id, product_id, quantity, ordered_at) VALUES
  (1, 1, 1, 2, '2024-01-15 10:30:00'),  -- Alice   x Widget      x 2
  (2, 2, 4, 1, '2024-01-16 14:45:00'),  -- Bob     x ThingamaBob x 1
  (3, 1, 2, 1, '2024-01-17 09:15:00'),  -- Alice   x Gadget      x 1
  (4, 3, 5, 3, '2024-01-18 16:20:00');  -- Charlie x Whatsit     x 3
