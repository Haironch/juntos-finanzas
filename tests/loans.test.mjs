import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let call, couple, stop;
beforeEach(async () => ({call, couple, stop} = await startApi()));
afterEach(() => stop());

// Mayra (pink) pagó una playera de Hairon (blue).
const shirt = (props = {}) => ({kind: 'expense', scope: 'personal', owner: 'blue', paidBy: 'pink', amountCents: 15000, description: 'Playera', occurredOn: '2026-09-30', category: 'Compras', ...props});
const add = (user, body) => call(user, 'POST', '/api/transactions', body);
const month = (user = 'azul') => call(user, 'GET', '/api/months/2026-09').then(r => r.body);
const settle = (user, items) => call(user, 'POST', '/api/pending/settle', {items: items.map(({id, version}) => ({id, version}))});

test('mientras no se devuelve, el préstamo se descuenta a quien pagó y el dueño le debe todo', async () => {
  await couple();
  const t = (await add('azul', shirt())).body;
  assert.deepEqual([t.loan, t.owner, t.paidBy, t.settled, t.pendingCents], [true, 'blue', 'pink', false, 15000]);
  const data = await month();
  assert.deepEqual(data.summary.expense, {blue: 0, pink: 15000});
  assert.deepEqual(data.pending.balance, {from: 'blue', to: 'pink', cents: 15000});
});

test('al devolverlo el gasto pasa al dueño y a quien pagó se le acredita', async () => {
  await couple();
  const t = (await add('rosa', shirt())).body;
  assert.equal((await settle('azul', [t])).body.balance, null);
  const data = await month();
  assert.deepEqual(data.summary.expense, {blue: 15000, pink: 0});
  assert.deepEqual(data.summary.balance, {blue: -15000, pink: 0});
  assert.deepEqual([data.transactions[0].settled, data.transactions[0].settledBy], [true, 'blue']);
});

test('préstamos y compartidos pendientes se compensan en el neto', async () => {
  await couple();
  await add('azul', {kind: 'expense', scope: 'shared', amountCents: 10000, description: 'Súper', occurredOn: '2026-09-29', category: 'Supermercado'});
  await add('rosa', shirt());
  const {pending} = await month();
  assert.deepEqual(pending.owes, {blue: 15000, pink: 5000});
  assert.deepEqual(pending.balance, {from: 'blue', to: 'pink', cents: 10000});
  assert.equal(pending.items.length, 2);
});

test('se puede registrar un préstamo ya devuelto y los ingresos nunca son préstamos', async () => {
  await couple();
  const paid = (await add('azul', shirt({settled: true}))).body;
  assert.deepEqual([paid.loan, paid.settled, paid.pendingCents], [true, true, 0]);
  assert.deepEqual((await month()).summary.expense, {blue: 15000, pink: 0});
  const income = (await add('azul', {kind: 'income', scope: 'personal', owner: 'blue', paidBy: 'pink', amountCents: 100, description: 'Sueldo', occurredOn: '2026-09-30'})).body;
  assert.deepEqual([income.loan, income.paidBy, income.settled], [false, null, null]);
});

test('editar: reabrir, quitar el préstamo o pasarlo a compartido', async () => {
  await couple();
  const t = (await add('azul', shirt({settled: true}))).body;
  const reopened = (await call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 1, settled: false})).body;
  assert.deepEqual([reopened.settled, reopened.pendingCents], [false, 15000]);
  const own = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 2, paidBy: 'blue'})).body;
  assert.deepEqual([own.loan, own.paidBy, own.settled], [false, null, null]);
  const loanAgain = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 3, paidBy: 'pink'})).body;
  assert.deepEqual([loanAgain.loan, loanAgain.settled], [true, false]);
  const shared = (await call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 4, scope: 'shared'})).body;
  assert.deepEqual([shared.scope, shared.loan, shared.paidBy, shared.settled, shared.pendingCents], ['shared', false, 'pink', false, 7500]);
});

test('valida el pagador de un préstamo', async () => {
  await couple();
  assert.equal((await add('azul', shirt({paidBy: 'green'}))).status, 400);
  assert.equal((await add('azul', shirt({settled: 'si'}))).status, 400);
  await call('solo', 'POST', '/api/household', {name: 'Solo', displayName: 'Solo'});
  assert.equal((await add('solo', shirt())).status, 409);
});
