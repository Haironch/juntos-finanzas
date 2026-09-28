// Hogar e invitaciones. userId siempre viene de la sesión (tabla users), nunca del navegador.
import {createHash, randomInt, randomUUID} from 'node:crypto';

export const COLORS = ['blue', 'pink', 'green', 'purple', 'orange', 'teal'];
// Sin 0/O ni 1/I para poder dictar el código. 12 caracteres de 32 posibles = 60 bits.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 12;
const INVITE_DAYS = 7;
const NOW = "strftime('%Y-%m-%dT%H:%M:%fZ','now')";

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const normalizeCode = code => String(code ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
const hashCode = code => createHash('sha256').update(normalizeCode(code)).digest('hex');

function requiredText(value, label, max) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text || text.length > max) throw new HttpError(400, `${label} debe tener entre 1 y ${max} caracteres`);
  return text;
}

// Abre una transacción de escritura; se revierte si fn lanza un error.
async function write(client, fn) {
  const tx = await client.transaction('write');
  try {
    const result = await fn(tx);
    await tx.commit();
    return result;
  } finally {
    tx.close();
  }
}

async function membership(tx, userId) {
  const {rows: [row]} = await tx.execute({
    sql: `SELECT m.household_id, (SELECT count(*) FROM household_members WHERE household_id = m.household_id) AS members
          FROM household_members m WHERE m.user_id = ?`,
    args: [userId],
  });
  return row ? {householdId: row.household_id, members: Number(row.members)} : null;
}

export async function getHousehold(client, userId) {
  const {rows} = await client.execute({
    sql: `SELECT h.id, h.name, h.currency, h.timezone, m.user_id, m.slot, m.color, m.display_name
          FROM household_members me
          JOIN households h ON h.id = me.household_id
          JOIN household_members m ON m.household_id = h.id
          WHERE me.user_id = ? ORDER BY m.slot`,
    args: [userId],
  });
  if (!rows.length) return null;
  const [{id, name, currency, timezone}] = rows;
  return {
    id, name, currency, timezone,
    members: rows.map(row => ({displayName: row.display_name, slot: row.slot, color: row.color, isMe: row.user_id === userId})),
  };
}

// Quien crea el hogar toma la posición permanente blue y el color azul predefinido.
export async function createHousehold(client, userId, body = {}) {
  const name = requiredText(body.name, 'El nombre del hogar', 60);
  const displayName = requiredText(body.displayName, 'Tu nombre', 24);
  await write(client, async tx => {
    if (await membership(tx, userId)) throw new HttpError(409, 'Ya perteneces a un hogar');
    const householdId = randomUUID();
    await tx.execute({sql: 'INSERT INTO households(id, name) VALUES (?, ?)', args: [householdId, name]});
    await tx.execute({
      sql: "INSERT INTO household_members(household_id, user_id, slot, color, display_name) VALUES (?, ?, 'blue', 'blue', ?)",
      args: [householdId, userId, displayName],
    });
  });
  return getHousehold(client, userId);
}

// Un código nuevo reemplaza a los anteriores sin usar. Solo se devuelve una vez; se guarda su hash.
export async function createInvite(client, userId) {
  return write(client, async tx => {
    const member = await membership(tx, userId);
    if (!member) throw new HttpError(403, 'Primero crea un hogar');
    if (member.members >= 2) throw new HttpError(409, 'El hogar ya tiene dos miembros');
    await tx.execute({sql: 'DELETE FROM household_invites WHERE household_id = ? AND used_at IS NULL', args: [member.householdId]});
    const code = Array.from({length: CODE_LENGTH}, () => CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]).join('');
    const {rows: [invite]} = await tx.execute({
      sql: `INSERT INTO household_invites(code_hash, household_id, created_by, expires_at)
            VALUES (?, ?, ?, strftime('%Y-%m-%dT%H:%M:%fZ','now','+${INVITE_DAYS} days')) RETURNING expires_at`,
      args: [hashCode(code), member.householdId, userId],
    });
    return {code: code.match(/.{4}/g).join('-'), expiresAt: invite.expires_at};
  });
}

// La pareja entra en la posición pink con el primer color libre (rosa por defecto).
export async function joinHousehold(client, userId, body = {}) {
  const displayName = requiredText(body.displayName, 'Tu nombre', 24);
  const code = normalizeCode(body.code);
  if (code.length !== CODE_LENGTH) throw new HttpError(400, 'Código inválido o vencido');
  await write(client, async tx => {
    if (await membership(tx, userId)) throw new HttpError(409, 'Ya perteneces a un hogar');
    const {rows: [invite]} = await tx.execute({
      sql: `SELECT household_id FROM household_invites WHERE code_hash = ? AND used_at IS NULL AND expires_at > ${NOW}`,
      args: [hashCode(code)],
    });
    if (!invite) throw new HttpError(400, 'Código inválido o vencido');
    const {rows: taken} = await tx.execute({sql: 'SELECT color FROM household_members WHERE household_id = ?', args: [invite.household_id]});
    if (taken.length >= 2) throw new HttpError(409, 'El hogar ya tiene dos miembros');
    const used = new Set(taken.map(row => row.color));
    const color = ['pink', ...COLORS].find(option => !used.has(option));
    await tx.execute({
      sql: "INSERT INTO household_members(household_id, user_id, slot, color, display_name) VALUES (?, ?, 'pink', ?, ?)",
      args: [invite.household_id, userId, color, displayName],
    });
    await tx.execute({
      sql: `UPDATE household_invites SET used_by = ?, used_at = ${NOW} WHERE code_hash = ?`,
      args: [userId, hashCode(code)],
    });
  });
  return getHousehold(client, userId);
}

// Cada persona edita su propio nombre y color; el color debe ser distinto al de su pareja.
export async function updateMember(client, userId, body = {}) {
  const changes = {};
  if (body.displayName !== undefined) changes.display_name = requiredText(body.displayName, 'Tu nombre', 24);
  if (body.color !== undefined) {
    if (!COLORS.includes(body.color)) throw new HttpError(400, `Color no válido. Opciones: ${COLORS.join(', ')}`);
    changes.color = body.color;
  }
  if (!Object.keys(changes).length) throw new HttpError(400, 'Indica displayName o color');
  await write(client, async tx => {
    const member = await membership(tx, userId);
    if (!member) throw new HttpError(403, 'Primero crea un hogar o únete a uno');
    if (changes.color) {
      const {rows} = await tx.execute({
        sql: 'SELECT 1 FROM household_members WHERE household_id = ? AND user_id <> ? AND color = ?',
        args: [member.householdId, userId, changes.color],
      });
      if (rows.length) throw new HttpError(409, 'Ese color ya lo usa tu pareja; elige otro');
    }
    const columns = Object.keys(changes);
    await tx.execute({
      sql: `UPDATE household_members SET ${columns.map(column => `${column} = ?`).join(', ')} WHERE user_id = ?`,
      args: [...columns.map(column => changes[column]), userId],
    });
  });
  return getHousehold(client, userId);
}
