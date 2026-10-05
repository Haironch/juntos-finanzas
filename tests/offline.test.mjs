import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop, sent;
beforeEach(async () => {
  sent = [];
  ({db, call, couple, stop} = await startApi({send: async (subscription, payload) => sent.push(JSON.parse(payload))}));
});
afterEach(() => stop());

const expense = (props = {}) => ({kind: 'expense', scope: 'shared', amountCents: 5000, description: 'Pan', occurredOn: '2026-10-04', category: 'Comida', ...props});
const count = async table => (await db.execute(`SELECT count(*) AS n FROM ${table}`)).rows[0].n;

test('reenviar un gasto con el mismo id (señal que se cae) no lo duplica ni repite la notificación', async () => {
  await couple();
  await call('azul', 'POST', '/api/push/subscribe', {endpoint: 'https://web.push.apple.com/hairon', keys: {p256dh: 'k', auth: 'a'}});
  const id = randomUUID();
  const first = await call('rosa', 'POST', '/api/transactions', expense({id}));
  const again = await call('rosa', 'POST', '/api/transactions', expense({id}));
  assert.equal(first.status, 200);
  assert.equal(again.status, 200);
  assert.equal(first.body.id, id);
  assert.equal(again.body.id, id);
  assert.equal(again.body.replayed, true);
  assert.equal(await count('transactions'), 1);
  assert.equal(sent.length, 1);
});

test('el id del teléfono se valida y no puede pisar el de otro hogar', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  assert.equal((await call('azul', 'POST', '/api/transactions', expense({id: 'no-es-uuid'}))).status, 400);
  const id = randomUUID();
  await call('azul', 'POST', '/api/transactions', expense({id}));
  assert.equal((await call('otro-azul', 'POST', '/api/transactions', expense({id}))).status, 409);
  const own = (await call('otro-azul', 'GET', '/api/months/2026-10')).body.transactions;
  assert.equal(own.length, 0);
});

test('sin id el servidor lo genera como siempre', async () => {
  await couple();
  const t = (await call('azul', 'POST', '/api/transactions', expense())).body;
  assert.match(t.id, /^[0-9a-f-]{36}$/);
  assert.equal(t.replayed, undefined);
});

test('la lista de compras funciona desde la cola sin señal: crear repetido, marcar y borrar sin versión', async () => {
  await couple();
  const id = randomUUID();
  await call('rosa', 'POST', '/api/tasks', {id, kind: 'buy', title: 'Leche'});
  await call('rosa', 'POST', '/api/tasks', {id, kind: 'buy', title: 'Leche'});
  assert.equal(await count('household_tasks'), 1);
  const done = await call('rosa', 'PATCH', `/api/tasks/${id}`, {done: true});
  assert.deepEqual([done.status, done.body.done], [200, true]);
  // Marcar de nuevo (reintento) no falla.
  assert.equal((await call('rosa', 'PATCH', `/api/tasks/${id}`, {done: true})).status, 200);
  // Cambiar el texto sí exige versión.
  assert.equal((await call('rosa', 'PATCH', `/api/tasks/${id}`, {title: 'Leche deslactosada'})).status, 400);
  assert.equal((await call('azul', 'DELETE', `/api/tasks/${id}`, {})).status, 200);
  assert.equal((await call('azul', 'DELETE', `/api/tasks/${id}`, {})).status, 404);
});
