import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop;
beforeEach(async () => ({db, call, couple, stop} = await startApi()));
afterEach(() => stop());

const add = (user, body) => call(user, 'POST', '/api/tasks', body);
const list = user => call(user, 'GET', '/api/tasks').then(r => r.body.items);

test('los dos ven la misma lista y queda quién agregó cada cosa', async () => {
  await couple();
  const milk = (await add('azul', {kind: 'buy', title: '  Leche  '})).body;
  assert.deepEqual([milk.title, milk.kind, milk.createdBy, milk.done, milk.amountCents, milk.dueOn], ['Leche', 'buy', 'blue', false, null, null]);
  const card = (await add('rosa', {kind: 'pay', title: 'Tarjeta BI', amountCents: 150000, dueOn: '2026-10-15'})).body;
  assert.deepEqual([card.createdBy, card.amountCents, card.dueOn], ['pink', 150000, '2026-10-15']);
  assert.deepEqual((await list('rosa')).map(t => t.title).sort(), ['Leche', 'Tarjeta BI']);
});

test('marcar como hecho guarda quién y cuándo; se puede desmarcar', async () => {
  await couple();
  const t = (await add('azul', {kind: 'buy', title: 'Pan'})).body;
  const done = (await call('rosa', 'PATCH', `/api/tasks/${t.id}`, {version: 1, done: true})).body;
  assert.deepEqual([done.done, done.doneBy, done.version, typeof done.doneAt], [true, 'pink', 2, 'string']);
  const renamed = (await call('azul', 'PATCH', `/api/tasks/${t.id}`, {version: 2, title: 'Pan dulce'})).body;
  assert.deepEqual([renamed.done, renamed.doneBy, renamed.doneAt], [true, 'pink', done.doneAt]);
  const undone = (await call('azul', 'PATCH', `/api/tasks/${t.id}`, {version: 3, done: false})).body;
  assert.deepEqual([undone.done, undone.doneBy, undone.doneAt], [false, null, null]);
});

test('orden: abiertos primero (pagos por fecha límite) y completados al final', async () => {
  await couple();
  const late = (await add('azul', {kind: 'pay', title: 'Luz', dueOn: '2026-10-20'})).body;
  await add('azul', {kind: 'pay', title: 'Tarjeta', dueOn: '2026-10-05'});
  await add('azul', {kind: 'buy', title: 'Arroz'});
  await call('azul', 'PATCH', `/api/tasks/${late.id}`, {version: 1, done: true});
  assert.deepEqual((await list('azul')).map(t => t.title), ['Tarjeta', 'Arroz', 'Luz']);
});

test('valida tipo, texto, monto y fecha', async () => {
  await couple();
  for (const body of [{kind: 'otro', title: 'x'}, {kind: 'buy', title: ' '}, {kind: 'buy', title: 'x'.repeat(101)},
    {kind: 'pay', title: 'x', amountCents: 0}, {kind: 'pay', title: 'x', amountCents: 1.5}, {kind: 'pay', title: 'x', dueOn: '2026-02-30'}]) {
    assert.equal((await add('azul', body)).status, 400, JSON.stringify(body));
  }
  const t = (await add('azul', {kind: 'pay', title: 'Agua', amountCents: 100, dueOn: '2026-10-10'})).body;
  const cleared = (await call('azul', 'PATCH', `/api/tasks/${t.id}`, {version: 1, amountCents: null, dueOn: null})).body;
  assert.deepEqual([cleared.amountCents, cleared.dueOn], [null, null]);
  assert.equal((await call('azul', 'PATCH', `/api/tasks/${t.id}`, {version: 2, done: 'si'})).status, 400);
});

test('una versión vieja devuelve 409 con el dato vigente; borrar exige la versión', async () => {
  await couple();
  const t = (await add('azul', {kind: 'buy', title: 'Huevos'})).body;
  await call('rosa', 'PATCH', `/api/tasks/${t.id}`, {version: 1, title: 'Huevos (30)'});
  const stale = await call('azul', 'PATCH', `/api/tasks/${t.id}`, {version: 1, done: true});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.title, 'Huevos (30)');
  assert.equal((await call('azul', 'DELETE', `/api/tasks/${t.id}`, {version: 1})).status, 409);
  assert.deepEqual((await call('azul', 'DELETE', `/api/tasks/${t.id}`, {version: 2})).body, {deleted: t.id});
  assert.equal((await list('azul')).length, 0);
});

test('borrar completados deja solo lo que falta', async () => {
  await couple();
  const a = (await add('azul', {kind: 'buy', title: 'Café'})).body;
  await add('azul', {kind: 'buy', title: 'Azúcar'});
  await call('rosa', 'PATCH', `/api/tasks/${a.id}`, {version: 1, done: true});
  assert.deepEqual((await call('rosa', 'DELETE', '/api/tasks/done', {})).body, {deleted: 1});
  assert.deepEqual((await list('azul')).map(t => t.title), ['Azúcar']);
});

test('un hogar no ve ni toca la lista de otro y sin hogar no hay lista', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  const mine = (await add('azul', {kind: 'buy', title: 'Leche'})).body;
  assert.equal((await list('otro-azul')).length, 0);
  assert.equal((await call('otro-azul', 'PATCH', `/api/tasks/${mine.id}`, {version: 1, done: true})).status, 404);
  assert.equal((await call('otro-rosa', 'DELETE', `/api/tasks/${mine.id}`, {version: 1})).status, 404);
  await call('otro-azul', 'DELETE', '/api/tasks/done', {});
  assert.equal((await list('azul')).length, 1);
  assert.equal((await call('nadie', 'GET', '/api/tasks')).status, 403);
});

test('la huella del hogar cambia con la lista para verla en vivo', async () => {
  await couple();
  const revision = () => call('azul', 'GET', '/api/sync').then(r => r.body.revision);
  const start = await revision();
  const t = (await add('rosa', {kind: 'buy', title: 'Pan'})).body;
  const added = await revision();
  assert.notEqual(added, start);
  await call('rosa', 'PATCH', `/api/tasks/${t.id}`, {version: 1, done: true});
  assert.notEqual(await revision(), added);
});

test('la base rechaza un pendiente con autor de otro hogar', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  const {rows: [home]} = await db.execute("SELECT household_id FROM household_members WHERE slot = 'blue' LIMIT 1");
  const {rows: [stranger]} = await db.execute({sql: 'SELECT user_id FROM household_members WHERE household_id <> ? LIMIT 1', args: [home.household_id]});
  await assert.rejects(db.execute({sql: "INSERT INTO household_tasks(id,household_id,kind,title,created_by) VALUES ('x',?,'buy','Pan',?)", args: [home.household_id, stranger.user_id]}), {code: /^SQLITE_CONSTRAINT/});
});
