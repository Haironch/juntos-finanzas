import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop;
beforeEach(async () => ({db, call, couple, stop} = await startApi()));
afterEach(() => stop());

const salary = (props = {}) => ({kind: 'income', scope: 'personal', owner: 'blue', amountCents: 800000, description: 'Sueldo', occurredOn: '2026-09-30', ...props});
const add = (user, body) => call(user, 'POST', '/api/transactions', body);
const month = (m, user = 'azul') => call(user, 'GET', `/api/months/${m}`).then(r => r.body);

test('el sueldo del 30 puede contar para el mes siguiente', async () => {
  await couple();
  const t = (await add('azul', salary({budgetMonth: '2026-10'}))).body;
  assert.deepEqual([t.occurredOn, t.budgetMonth], ['2026-09-30', '2026-10']);
  const october = await month('2026-10');
  assert.equal(october.transactions.length, 1);
  assert.equal(october.summary.income.blue, 800000);
  const september = await month('2026-09');
  assert.equal(september.transactions.length, 0);
  assert.equal(september.summary.total, 0);
});

test('sin indicarlo cuenta para el mes de su fecha', async () => {
  await couple();
  assert.equal((await add('azul', salary())).body.budgetMonth, '2026-09');
  assert.equal((await month('2026-09')).summary.income.blue, 800000);
});

test('solo se permite el mes de la fecha o el siguiente, también al cambiar de año', async () => {
  await couple();
  for (const budgetMonth of ['2026-08', '2026-11', '2026-13', 'octubre']) {
    assert.equal((await add('azul', salary({budgetMonth}))).status, 400, budgetMonth);
  }
  const newYear = (await add('azul', salary({occurredOn: '2026-12-31', budgetMonth: '2027-01'}))).body;
  assert.equal(newYear.budgetMonth, '2027-01');
  assert.equal((await month('2027-01')).summary.income.blue, 800000);
});

test('al editar la fecha se conserva el mes si sigue siendo válido y si no se ajusta', async () => {
  await couple();
  const t = (await add('azul', salary({budgetMonth: '2026-10'}))).body;
  const moved = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 1, occurredOn: '2026-10-01'})).body;
  assert.deepEqual([moved.occurredOn, moved.budgetMonth], ['2026-10-01', '2026-10']);
  const back = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 2, occurredOn: '2026-08-31'})).body;
  assert.deepEqual([back.occurredOn, back.budgetMonth], ['2026-08-31', '2026-08']);
  const explicit = (await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 3, budgetMonth: '2026-09'})).body;
  assert.equal(explicit.budgetMonth, '2026-09');
  assert.equal((await call('azul', 'PATCH', `/api/transactions/${t.id}`, {version: 4, budgetMonth: '2026-10'})).status, 400);
});

test('un gasto compartido del 30 para el mes siguiente se salda en ese mes', async () => {
  await couple();
  const rent = (await add('azul', {kind: 'expense', scope: 'shared', amountCents: 300001, description: 'Alquiler', occurredOn: '2026-09-30', budgetMonth: '2026-10', category: 'Hogar'})).body;
  assert.deepEqual((await month('2026-10')).summary.expense, {blue: 300001, pink: 0});
  await call('rosa', 'POST', '/api/pending/settle', {items: [{id: rent.id, version: rent.version}]});
  assert.deepEqual((await month('2026-10')).summary.expense, {blue: 150000, pink: 150001});
  assert.deepEqual((await month('2026-09')).summary.expense, {blue: 0, pink: 0});
});

test('la base rechaza un mes incoherente aunque se escriba directo', async () => {
  await couple();
  const {rows: [m]} = await db.execute("SELECT household_id, user_id FROM household_members WHERE slot = 'blue'");
  const insert = budgetMonth => db.execute({
    sql: `INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,budget_month,category,owner_user_id,created_by)
          VALUES (lower(hex(randomblob(8))),?,'income','personal',100,'x','2026-09-30',?,'Otros',?,?)`,
    args: [m.household_id, budgetMonth, m.user_id, m.user_id],
  });
  await assert.rejects(insert(null), /su fecha o el siguiente/);
  await assert.rejects(insert('2026-11'), /su fecha o el siguiente/);
  await insert('2026-10');
});
