import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let call, couple, stop;
beforeEach(async () => ({call, couple, stop} = await startApi()));
afterEach(() => stop());

const revision = user => call(user, 'GET', '/api/sync').then(r => r.body.revision);
const expense = {kind: 'expense', scope: 'shared', amountCents: 1000, description: 'Pan', occurredOn: '2026-10-01', category: 'Comida'};

test('la huella cambia con cada cambio de la pareja y es la misma para los dos', async () => {
  await couple();
  const start = await revision('azul');
  assert.equal(await revision('rosa'), start);
  assert.equal(await revision('azul'), start, 'sin cambios la huella no cambia');
  const t = (await call('rosa', 'POST', '/api/transactions', expense)).body;
  const added = await revision('azul');
  assert.notEqual(added, start);
  await call('rosa', 'PATCH', `/api/transactions/${t.id}`, {version: 1, description: 'Pan dulce'});
  const edited = await revision('azul');
  assert.notEqual(edited, added);
  await call('rosa', 'POST', '/api/pending/settle', {items: [{id: t.id, version: 2}]});
  const settled = await revision('azul');
  assert.notEqual(settled, edited);
  await call('rosa', 'DELETE', `/api/transactions/${t.id}`, {version: 3});
  const deleted = await revision('azul');
  assert.notEqual(deleted, settled);
  await call('rosa', 'PUT', '/api/months/2026-10/goal', {name: 'Viaje', amountCents: 100});
  const goal = await revision('azul');
  assert.notEqual(goal, deleted);
  await call('rosa', 'PATCH', '/api/household/me', {color: 'teal'});
  assert.notEqual(await revision('azul'), goal);
});

test('el mes trae la misma huella que la sincronización', async () => {
  await couple();
  await call('azul', 'POST', '/api/transactions', expense);
  const month = (await call('azul', 'GET', '/api/months/2026-10')).body;
  assert.equal(month.revision, await revision('rosa'));
});

test('cada hogar tiene su huella y sin hogar no hay sincronización', async () => {
  await couple();
  await couple('otro-azul', 'otro-rosa');
  const other = await revision('otro-azul');
  await call('azul', 'POST', '/api/transactions', expense);
  assert.equal(await revision('otro-azul'), other);
  assert.equal((await call('nadie', 'GET', '/api/sync')).status, 403);
  assert.equal((await call(null, 'GET', '/api/sync')).status, 401);
});
