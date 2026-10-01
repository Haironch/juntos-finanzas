-- Mes al que cuenta un movimiento, separado de su fecha: el sueldo del 30 de septiembre puede contar para octubre.
-- Solo se permite el mes de la fecha o el siguiente.
ALTER TABLE transactions ADD COLUMN budget_month TEXT;

-- Los movimientos existentes cuentan para el mes de su fecha, como hasta ahora.
UPDATE transactions SET budget_month = substr(occurred_on, 1, 7);

CREATE TRIGGER transactions_budget_month_insert
BEFORE INSERT ON transactions
WHEN NEW.budget_month IS NULL
  OR NEW.budget_month NOT IN (strftime('%Y-%m', NEW.occurred_on), strftime('%Y-%m', NEW.occurred_on, 'start of month', '+1 month'))
BEGIN
  SELECT RAISE(ABORT, 'El mes del movimiento debe ser el de su fecha o el siguiente');
END;

CREATE TRIGGER transactions_budget_month_update
BEFORE UPDATE ON transactions
WHEN NEW.budget_month IS NULL
  OR NEW.budget_month NOT IN (strftime('%Y-%m', NEW.occurred_on), strftime('%Y-%m', NEW.occurred_on, 'start of month', '+1 month'))
BEGIN
  SELECT RAISE(ABORT, 'El mes del movimiento debe ser el de su fecha o el siguiente');
END;

CREATE INDEX idx_transactions_household_budget_month ON transactions(household_id, budget_month, occurred_on);

-- La vista expone budget_month para filtrar cada mes por el mes al que cuenta y no por la fecha.
DROP VIEW transaction_allocations;
CREATE VIEW transaction_allocations AS
SELECT t.id AS transaction_id, t.household_id, m.user_id, m.slot,
       t.occurred_on, t.budget_month, t.kind,
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
