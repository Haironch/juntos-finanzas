// Lista compartida de pendientes: cosas por comprar (buy) y pagos por hacer (pay). Siempre acotada al hogar de la sesión.
import {clientId, HttpError, memberContext, NOW, requiredText, write} from './common.mjs';

const KINDS = ['buy', 'pay'];
const MAX_CENTS = 100_000_000_000;
const COLUMNS = 'id, kind, title, amount_cents, due_on, created_by, done_at, done_by, version, created_at, updated_at';

async function requireMember(executor, userId) {
  const context = await memberContext(executor, userId);
  if (!context) throw new HttpError(403, 'Primero crea un hogar o únete a uno');
  return context;
}

function optionalAmount(value) {
  if (value == null) return null;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_CENTS) throw new HttpError(400, 'amountCents debe ser un entero entre 1 y 100000000000 (centavos)');
  return value;
}

function optionalDate(value) {
  if (value == null || value === '') return null;
  const valid = typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value) && new Date(value + 'T12:00:00Z').toISOString().slice(0, 10) === value;
  if (!valid) throw new HttpError(400, 'dueOn debe ser una fecha válida AAAA-MM-DD');
  return value;
}

function toTask(row, context) {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    amountCents: row.amount_cents,
    dueOn: row.due_on,
    createdBy: context.slots[row.created_by],
    done: row.done_at !== null,
    doneAt: row.done_at,
    doneBy: row.done_by ? context.slots[row.done_by] : null,
    version: row.version,
    createdAt: row.created_at,
  };
}

async function findTask(tx, context, id) {
  const {rows: [row]} = await tx.execute({sql: `SELECT ${COLUMNS} FROM household_tasks WHERE household_id = ? AND id = ?`, args: [context.householdId, String(id)]});
  if (!row) throw new HttpError(404, 'Pendiente no encontrado');
  return row;
}

function assertVersion(row, expected, context) {
  if (!Number.isSafeInteger(expected) || expected < 1) throw new HttpError(400, 'Falta version (entero) para evitar sobrescribir cambios');
  if (row.version !== expected) throw new HttpError(409, 'Tu pareja cambió este pendiente; revisa la versión actual', {current: toTask(row, context)});
}

// Abiertos primero: pagos por fecha límite (sin fecha al final) y luego por antigüedad. Completados al final, recientes primero.
export async function listTasks(client, userId) {
  const context = await requireMember(client, userId);
  const {rows} = await client.execute({
    sql: `SELECT ${COLUMNS} FROM household_tasks WHERE household_id = ?
          ORDER BY done_at IS NOT NULL, CASE WHEN done_at IS NULL THEN due_on IS NULL END, due_on, CASE WHEN done_at IS NULL THEN created_at END, done_at DESC`,
    args: [context.householdId],
  });
  return {items: rows.map(row => toTask(row, context))};
}

export async function createTask(client, userId, body = {}) {
  if (!KINDS.includes(body.kind)) throw new HttpError(400, 'kind debe ser buy o pay');
  const title = requiredText(body.title, 'El pendiente', 100);
  const amountCents = optionalAmount(body.amountCents);
  const dueOn = optionalDate(body.dueOn);
  const id = clientId(body.id);
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    // Reenvío de un pendiente creado sin señal: se devuelve el que ya existe.
    const {rows: [existing]} = await tx.execute({sql: 'SELECT household_id FROM household_tasks WHERE id = ?', args: [id]});
    if (existing) {
      if (existing.household_id !== context.householdId) throw new HttpError(409, 'Ese identificador ya está en uso');
      return toTask(await findTask(tx, context, id), context);
    }
    const {rows: [row]} = await tx.execute({
      sql: `INSERT INTO household_tasks(id, household_id, kind, title, amount_cents, due_on, created_by) VALUES (?, ?, ?, ?, ?, ?, ?) RETURNING ${COLUMNS}`,
      args: [id, context.householdId, body.kind, title, amountCents, dueOn, userId],
    });
    return toTask(row, context);
  });
}

// Edición parcial; done marca o desmarca como hecho (guardando quién y cuándo).
export async function updateTask(client, userId, id, body = {}) {
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const row = await findTask(tx, context, id);
    // Solo marcar/desmarcar como hecho puede ir sin versión (llega desde la cola sin señal): gana el último.
    const onlyDone = body.version === undefined && Object.keys(body).every(key => key === 'done');
    if (!onlyDone) assertVersion(row, body.version, context);
    const title = body.title === undefined ? row.title : requiredText(body.title, 'El pendiente', 100);
    const kind = body.kind === undefined ? row.kind : body.kind;
    if (!KINDS.includes(kind)) throw new HttpError(400, 'kind debe ser buy o pay');
    const amountCents = body.amountCents === undefined ? row.amount_cents : optionalAmount(body.amountCents);
    const dueOn = body.dueOn === undefined ? row.due_on : optionalDate(body.dueOn);
    if (body.done !== undefined && typeof body.done !== 'boolean') throw new HttpError(400, 'done debe ser true o false');
    const done = body.done === undefined ? row.done_at !== null : body.done;
    const {rows: [updated]} = await tx.execute({
      sql: `UPDATE household_tasks SET kind = ?, title = ?, amount_cents = ?, due_on = ?,
              done_at = CASE WHEN ? THEN coalesce(done_at, ${NOW}) END,
              done_by = CASE WHEN ? THEN coalesce(done_by, ?) END,
              version = version + 1, updated_at = ${NOW}
            WHERE household_id = ? AND id = ? AND version = ? RETURNING ${COLUMNS}`,
      args: [kind, title, amountCents, dueOn, done ? 1 : 0, done ? 1 : 0, userId, context.householdId, row.id, row.version],
    });
    return toTask(updated, context);
  });
}

export async function deleteTask(client, userId, id, body = {}) {
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const row = await findTask(tx, context, id);
    // Sin versión (desde la cola sin señal) se borra igual: es una lista de compras.
    if (body.version !== undefined) assertVersion(row, body.version, context);
    await tx.execute({sql: 'DELETE FROM household_tasks WHERE household_id = ? AND id = ?', args: [context.householdId, row.id]});
    return {deleted: row.id};
  });
}

// Borra de una vez todos los pendientes ya hechos.
export async function clearDoneTasks(client, userId) {
  return write(client, async tx => {
    const context = await requireMember(tx, userId);
    const {rowsAffected} = await tx.execute({sql: 'DELETE FROM household_tasks WHERE household_id = ? AND done_at IS NOT NULL', args: [context.householdId]});
    return {deleted: rowsAffected};
  });
}
