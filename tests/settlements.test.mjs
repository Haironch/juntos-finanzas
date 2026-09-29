import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop;
beforeEach(async () => ({db, call, couple, stop} = await startApi()));
afterEach(() => stop());

const expense = (props = {}) => ({kind: 'expense', scope: 'shared', amountCents: 10001, description: 'Cena', occurredOn: '2026-09-15', category: 'Comida', ...props});
const add = (user, body) => call(user, 'POST', '/api/transactions', body);
const month = (user, m = '2026-09') => call(user, 'GET', `/api/months/${m}`).then(r => r.body);
const settle = (user, items) => call(user, 'POST', '/api/pending/settle', {items: items.map(({id, version}) => ({id, version}))});

test('un compartido nuevo queda pendiente: quien pagó carga todo y la pareja le debe su mitad', async () => {
  await couple();
  const t = (await add('azul', expense())).body;
  assert.deepEqual([t.paidBy, t.settled, t.pendingCents, t.createdBy], ['blue', false, 5001, 'blue']);
  const data = await month('rosa');
  assert.deepEqual(data.summary.expense, {blue: 10001, pink: 0});
  assert.deepEqual(data.pending.balance, {from: 'pink', to: 'blue', cents: 5001});
  assert.equal(data.pending.items.length, 1);
});

test('al saldar se divide mitad y mitad y desaparece de pendientes', async () => {
  await couple();
  const t = (await add('azul', expense())).body;
  const result = await settle('rosa', [t]);
  assert.equal(result.status, 200);
  assert.deepEqual(result.body, {items: [], owes: {blue: 0, pink: 0}, balance: null});
  const data = await month('azul');
  assert.deepEqual(data.summary.expense, {blue: 5000, pink: 5001});
  const saved = data.transactions[0];
  assert.deepEqual([saved.settled, saved.settledBy, saved.version, saved.pendingCents], [true, 'pink', 2, 0]);
});

test('se puede registrar que pagó la pareja y que ya transfirió en el momento', async () => {
  await couple();
  const t = (await add('rosa', expense({paidBy: 'blue', settled: true}))).body;
  assert.deepEqual([t.paidBy, t.createdBy, t.settled, t.settledBy], ['blue', 'pink', true, 'pink']);
  assert.deepEqual((await month('azul')).summary.expense, {blue: 5000, pink: 5001});
});

test('las deudas en ambos sentidos se compensan en el neto', async () => {
  await couple();
  await add('azul', expense({amountCents: 10000}));
  await add('rosa', expense({amountCents: 3000}));
  const {pending} = await month('azul');
  assert.deepEqual(pending.owes, {blue: 1500, pink: 5000});
  assert.deepEqual(pending.balance, {from: 'pink', to: 'blue', cents: 3500});
  assert.equal((await settle('azul', pending.items)).body.balance, null);
});

test('saldar todo con una versión vieja no marca ninguno', async () => {
  await couple();
  const a = (await add('azul', expense())).body;
  const b = (await add('azul', expense({amountCents: 500}))).body;
  await call('rosa', 'PATCH', `/api/transactions/${b.id}`, {version: 1, amountCents: 600});
  const result = await settle('azul', [a, b]);
  assert.equal(result.status, 409);
  assert.equal(result.body.current.amountCents, 600);
  assert.equal((await month('azul')).pending.items.length, 2);
});

test('lo pendiente de otro mes aparece siempre y al saldarlo corrige el mes del gasto', async () => {
  await couple();
  const august = (await add('azul', expense({occurredOn: '2026-08-20'}))).body;
  const september = await month('rosa', '2026-09');
  assert.equal(september.transactions.length, 0);
  assert.equal(september.pending.items[0].id, august.id);
  assert.deepEqual((await month('rosa', '2026-08')).summary.expense, {blue: 10001, pink: 0});
  await settle('rosa', september.pending.items);
  assert.deepEqual((await month('rosa', '2026-08')).summary.expense, {blue: 5000, pink: 5001});
  assert.deepEqual((await month('rosa', '2026-09')).summary.expense, {blue: 0, pink: 0});
});

test('editar permite desmarcar la transferencia y pasar a personal limpia el pagador', async () => {
  await couple();
  const t = (await add('azul', expense({settled: true}))).body;
  const reopened = (await call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 1, settled: false})).body;
  assert.deepEqual([reopened.settled, reopened.settledAt, reopened.pendingCents], [false, null, 5001]);
  const moved = (await call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 2, paidBy: 'pink'})).body;
  assert.deepEqual([moved.paidBy, moved.pendingCents], ['pink', 5000]);
  const personal = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 3, scope: 'personal', owner: 'blue'})).body;
  assert.deepEqual([personal.paidBy, personal.settled, personal.pendingCents], [null, null, 0]);
  assert.equal((await month('azul')).pending.items.length, 0);
});

test('editar un compartido saldado conserva quién y cuándo lo marcó', async () => {
  await couple();
  const t = (await add('azul', expense())).body;
  const [settled] = (await month('azul')).transactions;
  await settle('rosa', [settled]);
  const {transactions: [before]} = await month('azul');
  const edited = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: before.version, description: 'Cena de aniversario'})).body;
  assert.deepEqual([edited.settled, edited.settledBy, edited.settledAt], [true, 'pink', before.settledAt]);
});

test('valida pagador, estado y qué se puede saldar', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  assert.equal((await add('azul', expense({paidBy: 'green'}))).status, 400);
  assert.equal((await add('azul', expense({settled: 'si'}))).status, 400);
  const personal = (await add('azul', expense({scope: 'personal', owner: 'blue', paidBy: 'pink', settled: true}))).body;
  assert.deepEqual([personal.paidBy, personal.settled], [null, null]);
  assert.equal((await settle('azul', [personal])).status, 400);
  const mine = (await add('azul', expense())).body;
  assert.equal((await settle('otro-azul', [mine])).status, 404);
  assert.equal((await call('azul', 'POST', '/api/pending/settle', {items: []})).status, 400);
  assert.equal((await call('azul', 'POST', '/api/pending/settle', {items: [{id: mine.id}]})).status, 400);
  assert.equal((await call('azul', 'GET', '/api/pending')).body.items.length, 1);
});

test('la base rechaza pagadores incoherentes aunque se escriba directo', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  const {rows: [home]} = await db.execute("SELECT household_id AS id, user_id FROM household_members WHERE slot = 'blue' LIMIT 1");
  const {rows: [stranger]} = await db.execute({sql: 'SELECT user_id FROM household_members WHERE household_id <> ? LIMIT 1', args: [home.id]});
  const insert = (scope, paidBy, settledBy = null) => db.execute({
    sql: `INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,owner_user_id,created_by,paid_by,settled_at,settled_by)
          VALUES (lower(hex(randomblob(8))),?,'expense',?,100,'x','2026-09-01','Otros',?,?,?,?,?)`,
    args: [home.id, scope, scope === 'personal' ? home.user_id : null, home.user_id, paidBy, settledBy && '2026-09-01T00:00:00.000Z', settledBy],
  });
  await assert.rejects(insert('shared', null), /requiere quién pagó/);
  await assert.rejects(insert('personal', home.user_id), /Solo un gasto compartido/);
  await assert.rejects(insert('shared', stranger.user_id), /miembro del hogar/);
  await assert.rejects(insert('shared', home.user_id, stranger.user_id), /miembro del hogar/);
});
