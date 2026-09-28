-- SQLite / libSQL. Aplicar con foreign_keys=ON, dentro de una transacción.
-- Los IDs los genera el servidor. No almacenar contraseñas ni tokens aquí.
CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  auth_issuer TEXT NOT NULL CHECK(length(trim(auth_issuer)) > 0),
  auth_subject TEXT NOT NULL CHECK(length(trim(auth_subject)) > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE(auth_issuer, auth_subject)
);

CREATE TABLE households (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  currency TEXT NOT NULL DEFAULT 'GTQ' CHECK(currency = 'GTQ'),
  timezone TEXT NOT NULL DEFAULT 'America/Guatemala',
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- Dos posiciones únicas por hogar impiden agregar una tercera persona.
CREATE TABLE household_members (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  slot TEXT NOT NULL CHECK(slot IN ('blue','pink')),
  display_name TEXT NOT NULL CHECK(length(trim(display_name)) BETWEEN 1 AND 24),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(household_id, user_id),
  UNIQUE(household_id, slot),
  UNIQUE(user_id)
);

CREATE TABLE transactions (
  id TEXT PRIMARY KEY NOT NULL,
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  kind TEXT NOT NULL CHECK(kind IN ('income','expense')),
  scope TEXT NOT NULL CHECK(scope IN ('personal','shared')),
  amount_cents INTEGER NOT NULL
    CHECK(typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 100000000000),
  description TEXT NOT NULL CHECK(length(trim(description)) BETWEEN 1 AND 100),
  occurred_on TEXT NOT NULL CHECK(
    length(occurred_on) = 10 AND
    occurred_on GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]-[0-9][0-9]' AND
    date(occurred_on, '+0 days') IS NOT NULL AND
    date(occurred_on, '+0 days') = occurred_on
  ),
  category TEXT NOT NULL CHECK(category IN ('Hogar','Supermercado','Comida','Transporte','Salud','Ocio','Compras','Otros')),
  -- Dueño del ingreso/gasto personal; NULL para gastos compartidos.
  owner_user_id TEXT,
  -- Quien registra puede ser distinto del dueño. Se obtiene de la sesión.
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  FOREIGN KEY(household_id, owner_user_id) REFERENCES household_members(household_id, user_id),
  FOREIGN KEY(household_id, created_by) REFERENCES household_members(household_id, user_id),
  CHECK((scope = 'personal' AND owner_user_id IS NOT NULL) OR
        (scope = 'shared' AND kind = 'expense' AND owner_user_id IS NULL))
);

-- No permitir dividir un gasto mientras falta un miembro.
CREATE TRIGGER shared_requires_two_members_insert
BEFORE INSERT ON transactions WHEN NEW.scope = 'shared'
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM household_members WHERE household_id = NEW.household_id) <> 2
    THEN RAISE(ABORT, 'El gasto compartido requiere dos miembros') END;
END;
CREATE TRIGGER shared_requires_two_members_update
BEFORE UPDATE ON transactions WHEN NEW.scope = 'shared'
BEGIN
  SELECT CASE WHEN (SELECT count(*) FROM household_members WHERE household_id = NEW.household_id) <> 2
    THEN RAISE(ABORT, 'El gasto compartido requiere dos miembros') END;
END;
-- Las posiciones determinan el reparto histórico, por lo que son inmutables.
CREATE TRIGGER member_identity_immutable
BEFORE UPDATE OF household_id, user_id, slot ON household_members
BEGIN
  SELECT RAISE(ABORT, 'La identidad y el color de un miembro son permanentes');
END;
CREATE TRIGGER member_with_transactions_cannot_leave
BEFORE DELETE ON household_members
WHEN EXISTS(SELECT 1 FROM transactions WHERE household_id = OLD.household_id)
BEGIN
  SELECT RAISE(ABORT, 'No se puede retirar un miembro de un hogar con movimientos');
END;

CREATE TABLE monthly_goals (
  household_id TEXT NOT NULL REFERENCES households(id) ON DELETE RESTRICT,
  month TEXT NOT NULL CHECK(length(month) = 7 AND month GLOB '[0-9][0-9][0-9][0-9]-[0-9][0-9]' AND substr(month,6,2) BETWEEN '01' AND '12'),
  name TEXT NOT NULL CHECK(length(trim(name)) BETWEEN 1 AND 60),
  amount_cents INTEGER NOT NULL CHECK(typeof(amount_cents) = 'integer' AND amount_cents BETWEEN 1 AND 100000000000),
  created_by TEXT NOT NULL,
  version INTEGER NOT NULL DEFAULT 1 CHECK(typeof(version) = 'integer' AND version > 0),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  PRIMARY KEY(household_id, month),
  FOREIGN KEY(household_id, created_by) REFERENCES household_members(household_id, user_id)
);

CREATE INDEX idx_transactions_household_date ON transactions(household_id, occurred_on, id);

-- Fuente única de saldos, sin mantener totales duplicados que puedan desajustarse.
-- El centavo indivisible se carga al miembro rosa, igual que en la app local.
CREATE VIEW transaction_allocations AS
SELECT t.id AS transaction_id, t.household_id, m.user_id, m.slot,
       t.occurred_on, t.kind,
       CASE
         WHEN t.kind = 'income' THEN t.amount_cents
         WHEN t.scope = 'personal' THEN -t.amount_cents
         WHEN m.slot = 'blue' THEN -(t.amount_cents / 2)
         ELSE -(t.amount_cents - t.amount_cents / 2)
       END AS signed_amount_cents
FROM transactions t
JOIN household_members m ON m.household_id = t.household_id
  AND (t.scope = 'shared' OR m.user_id = t.owner_user_id);
