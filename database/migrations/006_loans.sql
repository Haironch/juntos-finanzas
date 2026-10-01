-- Préstamos: un gasto personal que pagó la otra persona (paid_by distinto del dueño).
-- Mientras no se devuelve (settled_at NULL) se descuenta a quien pagó; al devolverlo pasa al dueño.
DROP TRIGGER transactions_payment_insert;
DROP TRIGGER transactions_payment_update;

CREATE TRIGGER transactions_payment_insert
BEFORE INSERT ON transactions
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'income' AND (NEW.paid_by IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Un ingreso no tiene pagador ni devolución')
    WHEN NEW.scope = 'personal' AND NEW.paid_by IS NOT NULL AND NEW.paid_by = NEW.owner_user_id
      THEN RAISE(ABORT, 'En un préstamo paga la otra persona')
    WHEN NEW.scope = 'personal' AND NEW.paid_by IS NULL AND (NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Solo un préstamo o un gasto compartido se salda')
    WHEN NEW.scope = 'shared' AND NEW.paid_by IS NULL
      THEN RAISE(ABORT, 'Un gasto compartido requiere quién pagó')
    WHEN (NEW.settled_at IS NULL) <> (NEW.settled_by IS NULL)
      THEN RAISE(ABORT, 'La transferencia requiere fecha y autor')
    WHEN NEW.paid_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND user_id = NEW.paid_by)
      THEN RAISE(ABORT, 'Quien pagó debe ser miembro del hogar')
    WHEN NEW.settled_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND user_id = NEW.settled_by)
      THEN RAISE(ABORT, 'Quien marca la transferencia debe ser miembro del hogar')
  END;
END;

CREATE TRIGGER transactions_payment_update
BEFORE UPDATE ON transactions
BEGIN
  SELECT CASE
    WHEN NEW.kind = 'income' AND (NEW.paid_by IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Un ingreso no tiene pagador ni devolución')
    WHEN NEW.scope = 'personal' AND NEW.paid_by IS NOT NULL AND NEW.paid_by = NEW.owner_user_id
      THEN RAISE(ABORT, 'En un préstamo paga la otra persona')
    WHEN NEW.scope = 'personal' AND NEW.paid_by IS NULL AND (NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Solo un préstamo o un gasto compartido se salda')
    WHEN NEW.scope = 'shared' AND NEW.paid_by IS NULL
      THEN RAISE(ABORT, 'Un gasto compartido requiere quién pagó')
    WHEN (NEW.settled_at IS NULL) <> (NEW.settled_by IS NULL)
      THEN RAISE(ABORT, 'La transferencia requiere fecha y autor')
    WHEN NEW.paid_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND user_id = NEW.paid_by)
      THEN RAISE(ABORT, 'Quien pagó debe ser miembro del hogar')
    WHEN NEW.settled_by IS NOT NULL AND NOT EXISTS (SELECT 1 FROM household_members WHERE household_id = NEW.household_id AND user_id = NEW.settled_by)
      THEN RAISE(ABORT, 'Quien marca la transferencia debe ser miembro del hogar')
  END;
END;

-- Pendientes: compartidos sin transferir y préstamos sin devolver.
DROP INDEX idx_transactions_pending;
CREATE INDEX idx_transactions_pending ON transactions(household_id) WHERE paid_by IS NOT NULL AND settled_at IS NULL;

-- El préstamo también genera una fila para quien pagó, que carga el gasto hasta que se le devuelve.
DROP VIEW transaction_allocations;
CREATE VIEW transaction_allocations AS
SELECT t.id AS transaction_id, t.household_id, m.user_id, m.slot,
       t.occurred_on, t.budget_month, t.kind,
       CASE
         WHEN t.kind = 'income' THEN t.amount_cents
         WHEN t.scope = 'personal' AND t.paid_by IS NULL THEN -t.amount_cents
         WHEN t.scope = 'personal' AND t.settled_at IS NULL THEN CASE WHEN m.user_id = t.paid_by THEN -t.amount_cents ELSE 0 END
         WHEN t.scope = 'personal' THEN CASE WHEN m.user_id = t.owner_user_id THEN -t.amount_cents ELSE 0 END
         WHEN t.settled_at IS NULL THEN CASE WHEN m.user_id = t.paid_by THEN -t.amount_cents ELSE 0 END
         WHEN m.slot = 'blue' THEN -(t.amount_cents / 2)
         ELSE -(t.amount_cents - t.amount_cents / 2)
       END AS signed_amount_cents
FROM transactions t
JOIN household_members m ON m.household_id = t.household_id
  AND (t.scope = 'shared' OR m.user_id = t.owner_user_id OR m.user_id = t.paid_by);
