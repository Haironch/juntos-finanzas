// Utilidades compartidas por los módulos de datos del servidor.
import {randomUUID} from 'node:crypto';

export const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

// details viaja en la respuesta JSON junto al mensaje (por ejemplo, la versión actual en un conflicto).
export class HttpError extends Error {
  constructor(status, message, details) {
    super(message);
    this.status = status;
    this.details = details;
  }
}

export function requiredText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${label} debe tener entre 1 y ${max} caracteres`);
  return text;
}

// Identificador creado en el teléfono (UUID) para que reenviar un registro hecho sin señal no lo duplique.
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export function clientId(value) {
  if (value == null) return randomUUID();
  if (typeof value !== 'string' || !UUID.test(value)) throw new HttpError(400, 'id debe ser un UUID');
  return value.toLowerCase();
}

// Abre una transacción de escritura; se revierte si fn lanza un error.
export async function write(client, fn) {
  const tx = await client.transaction('write');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } finally {
    tx.close();
  }
}

// Hogar del usuario de la sesión y qué usuario ocupa cada posición. null si no pertenece a ninguno.
export async function memberContext(executor, userId) {
  const {rows} = await executor.execute({
    sql: `SELECT m.household_id, m.user_id, m.slot FROM household_members me
          JOIN household_members m ON m.household_id = me.household_id WHERE me.user_id = ?`,
    args: [userId],
  });
  if (!rows.length) return null;
  const users = Object.fromEntries(rows.map(row => [row.slot, row.user_id]));
  const slots = Object.fromEntries(rows.map(row => [row.user_id, row.slot]));
  return {householdId: rows[0].household_id, members: rows.length, mySlot: slots[userId], users, slots};
}
