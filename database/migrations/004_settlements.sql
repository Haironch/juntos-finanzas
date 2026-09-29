-- Gasto compartido pagado por una persona y pendiente de que la otra transfiera su mitad.
-- paid_by: quién pagó. settled_at/settled_by: cuándo y quién marcó la transferencia (NULL = pendiente).
ALTER TABLE transactions ADD COLUMN paid_by TEXT;
ALTER TABLE transactions ADD COLUMN settled_at TEXT;
ALTER TABLE transactions ADD COLUMN settled_by TEXT;

-- Los compartidos existentes ya se mostraban divididos: quedan saldados para conservar sus saldos.
UPDATE transactions SET paid_by = created_by, settled_at = updated_at, settled_by = created_by WHERE scope = 'shared';

-- ALTER TABLE no permite claves foráneas compuestas: los triggers validan pertenencia al hogar y coherencia.
CREATE TRIGGER transactions_payment_insert
BEFORE INSERT ON transactions
BEGIN
  SELECT CASE
    WHEN NEW.scope = 'personal' AND (NEW.paid_by IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Solo un gasto compartido tiene pagador y transferencia')
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
    WHEN NEW.scope = 'personal' AND (NEW.paid_by IS NOT NULL OR NEW.settled_at IS NOT NULL OR NEW.settled_by IS NOT NULL)
      THEN RAISE(ABORT, 'Solo un gasto compartido tiene pagador y transferencia')
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

CREATE INDEX idx_transactions_pending ON transactions(household_id) WHERE scope = 'shared' AND settled_at IS NULL;

-- Pendiente: quien pagó carga el gasto completo. Saldado: mitad y mitad, centavo impar para pink.
DROP VIEW transaction_allocations;
CREATE VIEW transaction_allocations AS
SELECT t.id AS transaction_id, t.household_id, m.user_id, m.slot,
       t.occurred_on, t.kind,
       CASE
         WHEN t.kind = 'income' THEN t.amount_cents
         WHEN t.scope = 'personal' THEN -t.amount_cents
         WHEN t.settled_at IS NULL THEN CASE WHEN m.user_id = t.paid_by THEN -t.amount_cents ELSE 0 END
         WHEN m.slot = 'blue' THEN -(t.amount_cents / 2)
         ELSE -(t.amount_cents - t.amount_cents / 2)
       END AS signed_amount_cents
FROM transactions t
JOIN household_members m ON m.household_id = t.household_id
  AND (t.scope = 'shared' OR m.user_id = t.owner_user_id);
