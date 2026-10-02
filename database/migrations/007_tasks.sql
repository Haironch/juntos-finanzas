-- Lista compartida de pendientes del hogar: cosas por comprar y pagos por hacer (tarjeta, servicios...).
CREATE TABLE household_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE CASCADE,
  kind TEXT NOT NULL CHECK(kind IN ('buy','pay')),
  title TEXT NOT NULL CHECK(length(trim(title)) BETWEEN 1 AND 100),
  -- Monto opcional (lo que hay que pagar o un estimado), en centavos.
  amount_cents INTEGER CHECK(amount_cents IS NULL OR (typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 100000000000)),
  -- Fecha límite opcional, útil en los pagos.
  due_on TEXT CHECK(due_on IS NULL OR (
    length(due_on) = 10 AND due_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND date(due_on, '+0 days') = due_on
  )),
  created_by TEXT NOT NULL,
  done_at TEXT,
  done_by TEXT,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(household_id, created_by) REFERENCES household_members(household_id, user_id),
  FOREIGN KEY(household_id, done_by) REFERENCES household_members(household_id, user_id),
  CHECK((done_at IS NULL) = (done_by IS NULL))
);

CREATE INDEX idx_household_tasks_household ON household_tasks(household_id, done_at, kind);
