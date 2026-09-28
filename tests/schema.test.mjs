import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {beforeEach, afterEach, test} from 'node:test';
import {createClient} from '@libsql/client';
import {migrate, readMigrations} from '../database/db.mjs';

// Mismo cliente libSQL que usará la API; cada prueba usa un archivo temporal propio.
let folder, db;
const constraint = {code: /^SQLITE_CONSTRAINT/};
const rows = async (sql, args = []) => (await db.execute({sql, args})).rows.map(row => [...Object.values(row)]);
const value = async (sql, args) => (await rows(sql, args))[0][0];

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'juntos-'));
  db = createClient({url: 'file:' + join(folder, 'test.db')});
  await migrate(db);
  await db.batch([
    ...['a', 'b', 'c'].map(user => ({sql: 'INSERT INTO users(id,auth_issuer,auth_subject) VALUES (?,?,?)', args: [user, 'test', user]})),
    "INSERT INTO households(id,name) VALUES ('home','Juntos'),('other','Otro')",
    "INSERT INTO household_members(household_id,user_id,slot,display_name) VALUES ('home','a','blue','Él'),('home','b','pink','Ella'),('other','c','blue','Otro')",
  ], 'write');
});

afterEach(() => {
  db.close();
  rmSync(folder, {recursive: true, force: true});
});

function add({id = 't', amount = 101, kind = 'expense', scope = 'shared', owner = null, creator = 'a', date = '2026-09-28', home = 'home'} = {}) {
  return db.execute({
    sql: 'INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,owner_user_id,created_by) VALUES (?,?,?,?,?,?,?,?,?,?)',
    args: [id, home, kind, scope, amount, 'Ejemplo', date, 'Hogar', owner, creator],
  });
}

test('reparte compartidos con el centavo impar para rosa y asigna personales', async () => {
  await add();
  assert.deepEqual(await rows('SELECT slot,signed_amount_cents FROM transaction_allocations ORDER BY slot'), [['blue', -50], ['pink', -51]]);
  await add({id: 'p', amount: 500, scope: 'personal', owner: 'b'});
  assert.deepEqual(await rows("SELECT user_id,signed_amount_cents FROM transaction_allocations WHERE transaction_id='p'"), [['b', -500]]);
});

test('totales mensuales reflejan edición y borrado', async () => {
  await add({id: 'income', amount: 800000, kind: 'income', scope: 'personal', owner: 'a'});
  await add({amount: 20000});
  await add({id: 'next', date: '2026-10-01'});
  const total = () => value("SELECT sum(signed_amount_cents) FROM transaction_allocations WHERE household_id='home' AND occurred_on>='2026-09-01' AND occurred_on<'2026-10-01'");
  assert.equal(await total(), 780000);
  await db.execute("UPDATE transactions SET amount_cents=40000 WHERE id='t'");
  assert.equal(await total(), 760000);
  await db.execute("DELETE FROM transactions WHERE id='t'");
  assert.equal(await total(), 800000);
});

test('rechaza importes, fechas e ingresos compartidos inválidos', async () => {
  for (const amount of [0, -1, 1.5, 100000000001]) await assert.rejects(add({amount}), constraint, `importe ${amount}`);
  for (const date of ['2026-02-30', '2026-13-01', 'not-a-date']) await assert.rejects(add({date}), constraint, `fecha ${date}`);
  await assert.rejects(add({kind: 'income'}), constraint);
});

test('impide referencias a miembros de otro hogar', async () => {
  await assert.rejects(add({creator: 'c'}), constraint);
  await assert.rejects(add({scope: 'personal', owner: 'c'}), constraint);
});

test('máximo dos miembros e identidad histórica permanente', async () => {
  await assert.rejects(db.execute("INSERT INTO household_members VALUES ('home','c','blue','Tercero',CURRENT_TIMESTAMP)"), constraint);
  await assert.rejects(add({home: 'other', creator: 'c'}), constraint);
  await add();
  await assert.rejects(db.execute("DELETE FROM household_members WHERE user_id='b'"), constraint);
  await assert.rejects(db.execute("UPDATE household_members SET slot='pink' WHERE user_id='a'"), constraint);
});

test('una meta validada por hogar y mes', async () => {
  const sql = 'INSERT INTO monthly_goals(household_id,month,name,amount_cents,created_by) VALUES (?,?,?,?,?)';
  await db.execute({sql, args: ['home', '2026-09', 'Viaje', 400000, 'a']});
  for (const args of [['home', '2026-09', 'Otra', 1, 'b'], ['home', '2026-13', 'Otra', 1, 'a'], ['home', '2026-10', 'Otra', 1, 'c'], ['home', '2026-10', 'Otra', 0, 'a']]) {
    await assert.rejects(db.execute({sql, args}), constraint, args.join(','));
  }
});

test('reaplicar migraciones conserva los datos', async () => {
  await add();
  assert.deepEqual(await migrate(db), []);
  assert.equal(await value('SELECT count(*) FROM transactions'), 1);
  assert.equal(await value('SELECT count(*) FROM schema_migrations'), readMigrations().length);
});

test('rechaza una migración aplicada que fue modificada', async () => {
  const [first] = readMigrations();
  await assert.rejects(migrate(db, [{...first, sha256: 'otro'}]), /modificada/);
});

test('una migración fallida no deja cambios parciales', async () => {
  const broken = {name: '999_broken.sql', sha256: 'x', sql: 'CREATE TABLE temporal(id INTEGER); INSERT INTO tabla_inexistente VALUES (1);'};
  await assert.rejects(migrate(db, [...readMigrations(), broken]));
  assert.equal(await value("SELECT count(*) FROM sqlite_master WHERE name='temporal'"), 0);
  assert.equal(await value("SELECT count(*) FROM schema_migrations WHERE name='999_broken.sql'"), 0);
});
