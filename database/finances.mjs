// Movimientos, metas y resumen mensual. Todo se acota al hogar del usuario de la sesión.
// Las personas se identifican por su posición (blue/pink), igual que en transaction_allocations.
import {createHash, randomUUID} from 'node:crypto';
import {HttpError, memberContext, NOW, requiredText, write} from './common.mjs';

export const CATEGORIES = ['Hogar', 'Supermercado', 'Comida', 'Transporte', 'Salud', 'Ocio', 'Compras', 'Otros'];
const MAX_CENTS = 100_000_000_000;
const SLOTS = ['blue', 'pink'];
const OTHER = {blue: 'pink', pink: 'blue'};
const MAX_SETTLE = 500;

// Parte de cada posición en un gasto compartido: el centavo impar es de pink, igual que en la vista.
export const shareOf = (amountCents, slot) => slot === 'blue' ? Math.floor(amountCents / 2) : amountCents - Math.floor(amountCents / 2);
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

export function nextMonth(month) {
  const [year, number] = month.split('-').map(Number);
  return number === 12 ? `${year + 1}-01` : `${year}-${String(number + 1).padStart(2, '0')}`;
}

export function parseMonth(month) {
  if (typeof month !== 'string' || !MONTH.test(month)) throw new HttpError(400, 'Mes inválido; usa AAAA-MM');
  return month;
}

// Mes al que cuenta: el de la fecha (por defecto) o el siguiente, p. ej. el sueldo del 30 para el mes que empieza.
function budgetMonth(value, occurredOn) {
  const own = occurredOn.slice(0, 7);
  const month = value ?? own;
  if (month !== own && month !== nextMonth(own)) throw new HttpError(400, 'budgetMonth debe ser el mes de la fecha o el siguiente');
  return month;
}

function amount(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CENTS) {
    throw new HttpError(400, 'amountCents debe ser un entero entre 1 y 100000000000 (centavos)');
  }
  return value;
}

function date(value) {
  const valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) &&
    new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  if (!valid) throw new HttpError(400, 'occurredOn debe ser una fecha válida AAAA-MM-DD');
  return value;
}

function version(value) {
  if (!Number.isSafeInteger(value) || value < 1) throw new HttpError(400, 'Falta version (entero) para evitar sobrescribir cambios');
  return value;
}

async function requireMember(executor, userId) {
  const context = await memberContext(executor, userId);
  if (!context) throw new HttpError(403, 'Primero crea un hogar o únete a uno');
  return context;
}

// Valida el movimiento completo y traduce owner (posición) al usuario de ese hogar.
function validTransaction(input, context) {
  if (!['income', 'expense'].includes(input.kind)) throw new HttpError(400, 'kind debe ser income o expense');
  if (!['personal', 'shared'].includes(input.scope)) throw new HttpError(400, 'scope debe ser personal o shared');
  if (input.kind === 'income' && input.scope === 'shared') throw new HttpError(400, 'Un ingreso siempre es personal');
  const category = input.category ?? (input.kind === 'income' ? 'Otros' : undefined);
  if (!CATEGORIES.includes(category)) throw new HttpError(400, `Categoría inválida. Opciones: ${CATEGORIES.join(', ')}`);
  let ownerUserId = null, paidByUserId = null, settled = false;
  if (input.scope === 'personal') {
    if (!SLOTS.includes(input.owner)) throw new HttpError(400, 'owner debe ser blue o pink en un movimiento personal');
    ownerUserId = context.users[input.owner];
    if (!ownerUserId) throw new HttpError(409, 'Esa persona todavía no se ha unido al hogar');
    // Préstamo: gasto personal que pagó la otra persona; queda pendiente hasta que se le devuelve.
    if (input.kind === 'expense' && input.paidBy != null && input.paidBy !== input.owner) {
      if (!SLOTS.includes(input.paidBy)) throw new HttpError(400, 'paidBy debe ser blue o pink');
      paidByUserId = context.users[input.paidBy];
      if (!paidByUserId) throw new HttpError(409, 'Esa persona todavía no se ha unido al hogar');
      if (input.settled != null && typeof input.settled !== 'boolean') throw new HttpError(400, 'settled debe ser true o false');
      settled = input.settled === true;
    }
  } else {
    if (context.members < 2) throw new HttpError(409, 'Un gasto compartido requiere que tu pareja se una al hogar');
    // Por defecto pagó quien lo registra y queda pendiente de transferencia.
    const paidBy = input.paidBy ?? context.mySlot;
    if (!SLOTS.includes(paidBy)) throw new HttpError(400, 'paidBy debe ser blue o pink');
    paidByUserId = context.users[paidBy];
    if (input.settled != null && typeof input.settled !== 'boolean') throw new HttpError(400, 'settled debe ser true o false');
    settled = input.settled === true;
  }
  const occurredOn = date(input.occurredOn);
  return {
    kind: input.kind,
    scope: input.scope,
    amountCents: amount(input.amountCents),
    description: requiredText(input.description, 'La descripción', 100),
    occurredOn,
    budgetMonth: budgetMonth(input.budgetMonth, occurredOn),
    category,
    ownerUserId,
    paidByUserId,
    settled,
  };
}

const TRANSACTION_COLUMNS = `id, kind, scope, amount_cents, description, occurred_on, budget_month, category,
  owner_user_id, created_by, paid_by, settled_at, settled_by, version, created_at, updated_at`;

function toTransaction(row, context) {
  return {
    id: row.id,
    kind: row.kind,
    scope: row.scope,
    amountCents: row.amount_cents,
    description: row.description,
    occurredOn: row.occurred_on,
    budgetMonth: row.budget_month,
    category: row.category,
    owner: row.owner_user_id ? context.slots[row.owner_user_id] : null,
    createdBy: context.slots[row.created_by],
    // Solo gastos compartidos: quién pagó y si la otra persona ya transfirió su mitad.
    paidBy: row.paid_by ? context.slots[row.paid_by] : null,
    loan: row.scope === 'personal' && row.paid_by !== null,
    settled: row.paid_by !== null ? row.settled_at !== null : null,
    settledAt: row.settled_at,
    settledBy: row.settled_by ? context.slots[row.settled_by] : null,
    // Lo que la otra persona debe a quien pagó: su mitad en un compartido, todo en un préstamo.
    pendingCents: row.paid_by === null || row.settled_at !== null ? 0
      : row.scope === 'shared' ? shareOf(row.amount_cents, OTHER[context.slots[row.paid_by]]) : row.amount_cents,
    version: row.version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

async function findTransaction(tx, context, id) {
  const {rows: [row]} = await tx.execute({
    sql: `SELECT ${TRANSACTION_COLUMNS} FROM transactions WHERE household_id = ? AND id = ?`,
    args: [context.householdId, String(id)],
  });
  if (!row) throw new HttpError(404, 'Movimiento no encontrado');
  return row;
}

function assertVersion(current, expected, toJson) {
  if (current.version !== expected) {
    throw new HttpError(409, 'Tu pareja modificó este dato mientras lo editabas; revisa la versión actual', {current: toJson(current)});
  }
}

export async function createTransaction(client, userId, body = {}) {
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const t = validTransaction(body, context);
    const {rows: [row]} = await tx.execute({
      sql: `INSERT INTO transactions(id, household_id, kind, scope, amount_cents, description, occurred_on, budget_month, category, owner_user_id, created_by,
              paid_by, settled_at, settled_by)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CASE WHEN ? THEN ${NOW} END, ?) RETURNING ${TRANSACTION_COLUMNS}`,
      args: [randomUUID(), context.householdId, t.kind, t.scope, t.amountCents, t.description, t.occurredOn, t.budgetMonth, t.category, t.ownerUserId, userId,
        t.paidByUserId, t.settled ? 1 : 0, t.settled ? userId : null],
    });
    return toTransaction(row, context);
  });
}

// Edición parcial: se combinan los campos enviados con los actuales y se valida el resultado completo.
export async function updateTransaction(client, userId, id, body = {}) {
  const expected = version(body.version);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const row = await findTransaction(tx, context, id);
    assertVersion(row, expected, current => toTransaction(current, context));
    const current = toTransaction(row, context);
    const merged = {...current, ...pick(body, ['kind', 'scope', 'amountCents', 'description', 'occurredOn', 'budgetMonth', 'category', 'owner', 'paidBy', 'settled'])};
    if (merged.scope === 'shared') merged.owner = null;
    // Al cambiar entre compartido y personal sin indicar pagador, se empieza de cero: compartido lo paga quien edita, personal no es préstamo.
    if (body.scope !== undefined && body.scope !== current.scope && body.paidBy === undefined) {
      delete merged.paidBy;
      delete merged.settled;
    }
    // Si cambia la fecha sin indicar mes, se conserva el mes actual mientras siga siendo válido.
    if (body.occurredOn !== undefined && body.budgetMonth === undefined && typeof merged.occurredOn === 'string') {
      const own = merged.occurredOn.slice(0, 7);
      if (merged.budgetMonth !== own && merged.budgetMonth !== nextMonth(own)) merged.budgetMonth = own;
    }
    const t = validTransaction(merged, context);
    // Una transferencia ya marcada conserva su fecha y autor; desmarcarla la vuelve pendiente.
    const {rows: [updated]} = await tx.execute({
      sql: `UPDATE transactions SET kind = ?, scope = ?, amount_cents = ?, description = ?, occurred_on = ?, budget_month = ?, category = ?,
              owner_user_id = ?, paid_by = ?,
              settled_at = CASE WHEN ? THEN coalesce(settled_at, ${NOW}) END,
              settled_by = CASE WHEN ? THEN coalesce(settled_by, ?) END,
              version = version + 1, updated_at = ${NOW}
            WHERE household_id = ? AND id = ? AND version = ? RETURNING ${TRANSACTION_COLUMNS}`,
      args: [t.kind, t.scope, t.amountCents, t.description, t.occurredOn, t.budgetMonth, t.category, t.ownerUserId, t.paidByUserId,
        t.settled ? 1 : 0, t.settled ? 1 : 0, userId, context.householdId, row.id, expected],
    });
    return toTransaction(updated, context);
  });
}

export async function deleteTransaction(client, userId, id, body = {}) {
  const expected = version(body.version);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const row = await findTransaction(tx, context, id);
    assertVersion(row, expected, current => toTransaction(current, context));
    await tx.execute({sql: 'DELETE FROM transactions WHERE household_id = ? AND id = ? AND version = ?', args: [context.householdId, row.id, expected]});
    return {deleted: row.id};
  });
}

// Marca como transferidos los gastos indicados con la versión que se vio. Si alguno cambió, no se marca ninguno.
export async function settleTransactions(client, userId, body = {}) {
  const items = body.items;
  if (!Array.isArray(items) || !items.length || items.length > MAX_SETTLE) throw new HttpError(400, `items debe tener entre 1 y ${MAX_SETTLE} gastos`);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    for (const item of items) {
      const row = await findTransaction(tx, context, item?.id);
      assertVersion(row, version(item.version), current => toTransaction(current, context));
      if (row.paid_by === null) throw new HttpError(400, 'Solo un gasto compartido o un préstamo se puede saldar');
      if (row.settled_at !== null) continue;
      await tx.execute({
        sql: `UPDATE transactions SET settled_at = ${NOW}, settled_by = ?, version = version + 1, updated_at = ${NOW}
              WHERE household_id = ? AND id = ? AND version = ?`,
        args: [userId, context.householdId, row.id, row.version],
      });
    }
    return pendingFor(tx, context);
  });
}

// Compartidos sin transferir y préstamos sin devolver, de cualquier mes, y cuánto se deben en neto.
// Con dos miembros, quien debe siempre es la otra persona de quien pagó.
async function pendingFor(executor, context) {
  const {rows} = await executor.execute({
    sql: `SELECT ${TRANSACTION_COLUMNS} FROM transactions
          WHERE household_id = ? AND paid_by IS NOT NULL AND settled_at IS NULL ORDER BY occurred_on, created_at`,
    args: [context.householdId],
  });
  const items = rows.map(row => toTransaction(row, context));
  const owes = {blue: 0, pink: 0};
  for (const item of items) owes[OTHER[item.paidBy]] += item.pendingCents;
  const net = owes.blue - owes.pink;
  const balance = net === 0 ? null : net > 0 ? {from: 'blue', to: 'pink', cents: net} : {from: 'pink', to: 'blue', cents: -net};
  return {items, owes, balance};
}

// Huella del hogar: cambia con cualquier alta, edición o baja de movimientos y metas, y con nombres o colores.
// La app la consulta cada pocos segundos para traer los cambios de la pareja sin descargar todo.
async function revisionFor(executor, householdId) {
  const {rows: [row]} = await executor.execute({
    sql: `SELECT
            (SELECT count(*) || ':' || coalesce(sum(version), 0) || ':' || coalesce(max(updated_at), '') FROM transactions WHERE household_id = ?1) AS t,
            (SELECT count(*) || ':' || coalesce(sum(version), 0) || ':' || coalesce(max(updated_at), '') FROM monthly_goals WHERE household_id = ?1) AS g,
            (SELECT group_concat(slot || '=' || color || '=' || display_name, '|') FROM (SELECT * FROM household_members WHERE household_id = ?1 ORDER BY slot)) AS m`,
    args: [householdId],
  });
  return createHash('sha256').update(`${row.t}#${row.g}#${row.m}`).digest('hex').slice(0, 16);
}

export async function getRevision(client, userId) {
  const context = await requireMember(client, userId);
  return {revision: await revisionFor(client, context.householdId)};
}

export async function getPending(client, userId) {
  return pendingFor(client, await requireMember(client, userId));
}

const pick = (source, keys) => Object.fromEntries(keys.filter(key => source[key] !== undefined).map(key => [key, source[key]]));

function toGoal(row) {
  return row ? {month: row.month, name: row.name, amountCents: row.amount_cents, version: row.version, updatedAt: row.updated_at} : null;
}

// Crea la meta del mes (sin version) o la reemplaza (con la version actual).
export async function saveGoal(client, userId, month, body = {}) {
  parseMonth(month);
  const name = requiredText(body.name, 'El nombre de la meta', 60);
  const amountCents = amount(body.amountCents);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const {rows: [existing]} = await tx.execute({
      sql: 'SELECT * FROM monthly_goals WHERE household_id = ? AND month = ?',
      args: [context.householdId, month],
    });
    if (existing) {
      assertVersion(existing, version(body.version), toGoal);
      const {rows: [row]} = await tx.execute({
        sql: `UPDATE monthly_goals SET name = ?, amount_cents = ?, version = version + 1, updated_at = ${NOW}
              WHERE household_id = ? AND month = ? RETURNING *`,
        args: [name, amountCents, context.householdId, month],
      });
      return toGoal(row);
    }
    if (body.version !== undefined) throw new HttpError(409, 'La meta fue eliminada mientras la editabas', {current: null});
    const {rows: [row]} = await tx.execute({
      sql: 'INSERT INTO monthly_goals(household_id, month, name, amount_cents, created_by) VALUES (?, ?, ?, ?, ?) RETURNING *',
      args: [context.householdId, month, name, amountCents, userId],
    });
    return toGoal(row);
  });
}

export async function deleteGoal(client, userId, month, body = {}) {
  parseMonth(month);
  const expected = version(body.version);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const {rows: [existing]} = await tx.execute({
      sql: 'SELECT * FROM monthly_goals WHERE household_id = ? AND month = ?',
      args: [context.householdId, month],
    });
    if (!existing) throw new HttpError(404, 'Este mes no tiene meta');
    assertVersion(existing, expected, toGoal);
    await tx.execute({sql: 'DELETE FROM monthly_goals WHERE household_id = ? AND month = ?', args: [context.householdId, month]});
    return {deleted: month};
  });
}

// Movimientos, meta y saldos del mes (por el mes al que cuentan) en una sola lectura consistente. Sin arrastre entre meses.
export async function getMonth(client, userId, month) {
  parseMonth(month);
  const tx = await client.transaction('read');
  try {
    const context = await requireMember(tx, userId);
    const range = [context.householdId, month];
    const {rows: transactions} = await tx.execute({
      sql: `SELECT ${TRANSACTION_COLUMNS} FROM transactions
            WHERE household_id = ? AND budget_month = ? ORDER BY occurred_on DESC, created_at DESC`,
      args: range,
    });
    const {rows: [goal]} = await tx.execute({sql: 'SELECT * FROM monthly_goals WHERE household_id = ? AND month = ?', args: [context.householdId, month]});
    const {rows: totals} = await tx.execute({
      sql: `SELECT slot, kind, sum(signed_amount_cents) AS cents FROM transaction_allocations
            WHERE household_id = ? AND budget_month = ? GROUP BY slot, kind`,
      args: range,
    });
    return {
      month,
      transactions: transactions.map(row => toTransaction(row, context)),
      goal: toGoal(goal),
      summary: summarize(totals),
      pending: await pendingFor(tx, context),
      revision: await revisionFor(tx, context.householdId),
    };
  } finally {
    tx.close();
  }
}

// Mismos conceptos que summary() de public/finance.js: gastos en positivo, saldo = ingresos - gastos.
function summarize(totals) {
  const zero = () => ({blue: 0, pink: 0});
  const income = zero(), expense = zero(), balance = zero();
  for (const {slot, kind, cents} of totals) {
    if (kind === 'income') income[slot] += cents;
    else expense[slot] -= cents;
    balance[slot] += cents;
  }
  const sum = values => values.blue + values.pink;
  return {income, expense, balance, totalIncome: sum(income), totalExpense: sum(expense), total: sum(balance)};
}
