import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop;
beforeEach(async () => ({db, call, couple, stop} = await startApi()));
afterEach(() => stop());

const expense = (props = {}) => ({kind: 'expense', scope: 'shared', amountCents: 10000, description: 'Súper', occurredOn: '2026-09-15', category: 'Supermercado', ...props});
const income = (owner, amountCents, props = {}) => ({kind: 'income', scope: 'personal', owner, amountCents, description: 'Sueldo', occurredOn: '2026-09-01', ...props});
const add = (user, body) => call(user, 'POST', '/api/transactions', body);

test('el resumen del mes coincide con el motor local, incluido el centavo impar', async () => {
  await couple();
  await add('azul', income('blue', 800000));
  await add('rosa', income('pink', 600000));
  await add('azul', expense({amountCents: 200001, settled: true}));
  await add('rosa', expense({scope: 'personal', owner: 'pink', amountCents: 50000, category: 'Compras'}));
  await add('azul', expense({occurredOn: '2026-10-01', amountCents: 900000}));
  const {status, body} = await call('rosa', 'GET', '/api/months/2026-09');
  assert.equal(status, 200);
  assert.equal(body.transactions.length, 4);
  assert.deepEqual(body.summary, {
    income: {blue: 800000, pink: 600000},
    expense: {blue: 100000, pink: 150001},
    balance: {blue: 700000, pink: 449999},
    totalIncome: 1400000, totalExpense: 250001, total: 1149999,
  });
  // Meses independientes: octubre no arrastra el saldo de septiembre.
  assert.equal((await call('azul', 'GET', '/api/months/2026-10')).body.summary.total, -900000);
  assert.equal((await call('azul', 'GET', '/api/months/2026-08')).body.summary.total, 0);
});

test('guarda quién registró cada movimiento y de quién es', async () => {
  await couple();
  const {status, body} = await add('rosa', expense({scope: 'personal', owner: 'blue', description: '  Gasolina  ', category: 'Transporte'}));
  assert.equal(status, 200);
  assert.equal(body.owner, 'blue');
  assert.equal(body.createdBy, 'pink');
  assert.equal(body.description, 'Gasolina');
  assert.equal(body.version, 1);
  const shared = (await add('azul', expense())).body;
  assert.equal(shared.owner, null);
  // Un ingreso sin categoría queda en Otros.
  assert.equal((await add('azul', income('blue', 100))).body.category, 'Otros');
});

test('valida importes, fechas, categorías, alcance y dueño', async () => {
  await couple();
  const invalid = [
    expense({amountCents: 0}), expense({amountCents: 12.5}), expense({amountCents: '100'}), expense({amountCents: 100000000001}),
    expense({occurredOn: '2026-02-30'}), expense({occurredOn: '15/09/2026'}),
    expense({category: 'Viajes'}), expense({description: ' '}), expense({description: 'x'.repeat(101)}),
    expense({kind: 'regalo'}), expense({scope: 'personal'}), expense({scope: 'personal', owner: 'green'}),
    income('blue', 100, {scope: 'shared'}),
  ];
  for (const body of invalid) assert.equal((await add('azul', body)).status, 400, JSON.stringify(body));
  assert.equal((await call('azul', 'GET', '/api/months/2026-13')).status, 400);
  assert.equal((await call('azul', 'GET', '/api/months/septiembre')).status, 400);
});

test('sin pareja solo se registran movimientos propios', async () => {
  await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'Hairon'});
  assert.equal((await add('azul', income('blue', 100))).status, 200);
  assert.equal((await add('azul', expense())).status, 409);
  assert.equal((await add('azul', expense({scope: 'personal', owner: 'pink'}))).status, 409);
  assert.equal((await add('nadie', expense())).status, 403);
  assert.equal((await call('nadie', 'GET', '/api/months/2026-09')).status, 403);
});

test('editar con la versión actual; una versión vieja devuelve 409 con el dato vigente', async () => {
  await couple();
  const created = (await add('azul', expense({amountCents: 101}))).body;
  const edited = await call('rosa', 'PATCH', `/api/transactions/${created.id}`, {version: 1, amountCents: 5000, scope: 'personal', owner: 'pink'});
  assert.equal(edited.status, 200);
  assert.deepEqual([edited.body.amountCents, edited.body.owner, edited.body.version, edited.body.createdBy], [5000, 'pink', 2, 'blue']);
  const stale = await call('azul', 'PATCH', `/api/transactions/${created.id}`, {version: 1, description: 'Pisar cambios'});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.version, 2);
  assert.equal(stale.body.current.description, 'Súper');
  // Volver a compartido limpia el dueño.
  const back = await call('azul', 'PATCH', `/api/transactions/${created.id}`, {version: 2, scope: 'shared'});
  assert.deepEqual([back.body.scope, back.body.owner, back.body.version], ['shared', null, 3]);
  assert.equal((await call('azul', 'PATCH', `/api/transactions/${created.id}`, {amountCents: 1})).status, 400);
  assert.equal((await call('azul', 'PATCH', `/api/transactions/${created.id}`, {version: 3, amountCents: -1})).status, 400);
});

test('eliminar exige la versión actual y recalcula el resumen', async () => {
  await couple();
  await add('azul', income('blue', 1000));
  const t = (await add('azul', expense({amountCents: 400}))).body;
  assert.equal((await call('rosa', 'DELETE', `/api/transactions/${t.id}`, {version: 7})).status, 409);
  assert.deepEqual((await call('rosa', 'DELETE', `/api/transactions/${t.id}`, {version: 1})).body, {deleted: t.id});
  assert.equal((await call('rosa', 'DELETE', `/api/transactions/${t.id}`, {version: 1})).status, 404);
  assert.equal((await call('azul', 'GET', '/api/months/2026-09')).body.summary.total, 1000);
});

test('un hogar no puede leer, editar ni borrar movimientos de otro', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  const mine = (await add('azul', expense())).body;
  assert.equal((await call('otro-azul', 'GET', '/api/months/2026-09')).body.transactions.length, 0);
  assert.equal((await call('otro-azul', 'PATCH', `/api/transactions/${mine.id}`, {version: 1, amountCents: 1})).status, 404);
  assert.equal((await call('otro-rosa', 'DELETE', `/api/transactions/${mine.id}`, {version: 1})).status, 404);
  assert.equal((await db.execute('SELECT amount_cents FROM transactions')).rows[0].amount_cents, 10000);
});

test('la meta del mes se crea, se edita con versión y se elimina', async () => {
  await couple();
  const created = await call('azul', 'PUT', '/api/months/2026-09/goal', {name: 'Viaje', amountCents: 400000});
  assert.equal(created.status, 200);
  assert.deepEqual([created.body.name, created.body.amountCents, created.body.version], ['Viaje', 400000, 1]);
  // Sin version no se puede pisar una meta existente.
  assert.equal((await call('rosa', 'PUT', '/api/months/2026-09/goal', {name: 'Otra', amountCents: 1})).status, 400);
  const edited = await call('rosa', 'PUT', '/api/months/2026-09/goal', {name: 'Viaje a Petén', amountCents: 500000, version: 1});
  assert.equal(edited.body.version, 2);
  const stale = await call('azul', 'PUT', '/api/months/2026-09/goal', {name: 'Viaje', amountCents: 1, version: 1});
  assert.equal(stale.status, 409);
  assert.equal(stale.body.current.name, 'Viaje a Petén');
  assert.deepEqual((await call('azul', 'GET', '/api/months/2026-09')).body.goal.amountCents, 500000);
  assert.equal((await call('azul', 'GET', '/api/months/2026-10')).body.goal, null);
  assert.equal((await call('azul', 'PUT', '/api/months/2026-09/goal', {name: 'Viaje', amountCents: 0, version: 2})).status, 400);
  assert.equal((await call('azul', 'DELETE', '/api/months/2026-09/goal', {version: 2})).status, 200);
  assert.equal((await call('azul', 'DELETE', '/api/months/2026-09/goal', {version: 2})).status, 404);
  // Editar una meta que la pareja acaba de borrar avisa en lugar de recrearla.
  assert.equal((await call('rosa', 'PUT', '/api/months/2026-09/goal', {name: 'Viaje', amountCents: 1, version: 2})).status, 409);
});

test('dos ediciones simultáneas con la misma versión: una gana y la otra recibe 409', async () => {
  await couple();
  const t = (await add('azul', expense())).body;
  const results = await Promise.all([
    call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 1, amountCents: 111}),
    call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 1, amountCents: 222}),
  ]);
  assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
  const winner = results.find(r => r.status === 200).body.amountCents;
  assert.equal((await db.execute('SELECT amount_cents, version FROM transactions')).rows[0].amount_cents, winner);
});

test('muchos registros simultáneos se guardan todos', async () => {
  await couple();
  const results = await Promise.all(Array.from({length: 20}, (_, i) => add(i % 2 ? 'rosa' : 'azul', expense({amountCents: 100 + i}))));
  assert.deepEqual([...new Set(results.map(r => r.status))], [200]);
  assert.equal((await call('azul', 'GET', '/api/months/2026-09')).body.transactions.length, 20);
});
