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
    "INSERT INTO household_members(household_id,user_id,slot,color,display_name) VALUES ('home','a','blue','blue','Él'),('home','b','pink','pink','Ella'),('other','c','blue','blue','Otro')",
  ], 'write');
});

afterEach(() => {
  db.close();
  rmSync(folder, {recursive: true, force: true});
});

// Por defecto un compartido lo pagó quien lo registra y ya está saldado (mitad y mitad).
function add({id = 't', amount = 101, kind = 'expense', scope = 'shared', owner = null, creator = 'a', date = '2026-09-28', home = 'home', payer = scope === 'shared' ? creator : null, settled = scope === 'shared'} = {}) {
  return db.execute({
    sql: `INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,budget_month,category,owner_user_id,created_by,paid_by,settled_at,settled_by)
          VALUES (?,?,?,?,?,?,?,substr(?,1,7),?,?,?,?,CASE WHEN ? THEN '2026-09-30T00:00:00.000Z' END,?)`,
    args: [id, home, kind, scope, amount, 'Ejemplo', date, date, 'Hogar', owner, creator, payer, settled ? 1 : 0, settled ? creator : null],
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
  await assert.rejects(db.execute("INSERT INTO household_members(household_id,user_id,slot,color,display_name) VALUES ('home','c','blue','green','Tercero')"), constraint);
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

test('la migración 004 deja saldados los compartidos que ya existían, sin cambiar saldos', async () => {
  const upgradeFolder = mkdtempSync(join(tmpdir(), 'juntos-upgrade-'));
  const old = createClient({url: 'file:' + join(upgradeFolder, 'test.db')});
  try {
    const migrations = readMigrations();
    await migrate(old, migrations.filter(m => m.name < '004'));
    await old.batch([
      "INSERT INTO users(id,auth_issuer,auth_subject) VALUES ('a','test','a'),('b','test','b')",
      "INSERT INTO households(id,name) VALUES ('home','Juntos')",
      "INSERT INTO household_members(household_id,user_id,slot,color,display_name) VALUES ('home','a','blue','blue','Él'),('home','b','pink','pink','Ella')",
      "INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,created_by) VALUES ('t','home','expense','shared',101,'Súper','2026-09-28','Hogar','b')",
    ], 'write');
    assert.deepEqual(await migrate(old, migrations.filter(m => m.name < '005')), ['004_settlements.sql']);
    const {rows: [t]} = await old.execute('SELECT paid_by, settled_by, settled_at IS NOT NULL AS settled FROM transactions');
    assert.deepEqual([t.paid_by, t.settled_by, t.settled], ['b', 'b', 1]);
    const {rows} = await old.execute('SELECT slot, signed_amount_cents FROM transaction_allocations ORDER BY slot');
    assert.deepEqual(rows.map(row => [row.slot, row.signed_amount_cents]), [['blue', -50], ['pink', -51]]);
  } finally {
    old.close();
    rmSync(upgradeFolder, {recursive: true, force: true});
  }
});

test('la migración 005 deja cada movimiento existente en el mes de su fecha', async () => {
  const upgradeFolder = mkdtempSync(join(tmpdir(), 'juntos-upgrade-'));
  const old = createClient({url: 'file:' + join(upgradeFolder, 'test.db')});
  try {
    const migrations = readMigrations();
    await migrate(old, migrations.filter(m => m.name < '005'));
    await old.batch([
      "INSERT INTO users(id,auth_issuer,auth_subject) VALUES ('a','test','a')",
      "INSERT INTO households(id,name) VALUES ('home','Juntos')",
      "INSERT INTO household_members(household_id,user_id,slot,color,display_name) VALUES ('home','a','blue','blue','Él')",
      "INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,owner_user_id,created_by) VALUES ('t','home','income','personal',800000,'Sueldo','2026-09-30','Otros','a','a')",
    ], 'write');
    assert.deepEqual(await migrate(old, migrations.filter(m => m.name < '006')), ['005_budget_month.sql']);
    assert.equal(await old.execute('SELECT budget_month FROM transactions').then(r => r.rows[0].budget_month), '2026-09');
    assert.equal(await old.execute("SELECT sum(signed_amount_cents) AS s FROM transaction_allocations WHERE budget_month = '2026-09'").then(r => r.rows[0].s), 800000);
  } finally {
    old.close();
    rmSync(upgradeFolder, {recursive: true, force: true});
  }
});

test('la migración 006 no cambia los saldos de lo ya registrado', async () => {
  const upgradeFolder = mkdtempSync(join(tmpdir(), 'juntos-upgrade-'));
  const old = createClient({url: 'file:' + join(upgradeFolder, 'test.db')});
  const totals = async () => (await old.execute('SELECT slot, sum(signed_amount_cents) AS c FROM transaction_allocations GROUP BY slot ORDER BY slot')).rows.map(r => [r.slot, r.c]);
  try {
    const migrations = readMigrations();
    await migrate(old, migrations.filter(m => m.name < '006'));
    await old.batch([
      "INSERT INTO users(id,auth_issuer,auth_subject) VALUES ('a','test','a'),('b','test','b')",
      "INSERT INTO households(id,name) VALUES ('home','Juntos')",
      "INSERT INTO household_members(household_id,user_id,slot,color,display_name) VALUES ('home','a','blue','blue','Él'),('home','b','pink','pink','Ella')",
      `INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,budget_month,category,owner_user_id,created_by,paid_by,settled_at,settled_by) VALUES
        ('i','home','income','personal',800000,'Sueldo','2026-09-01','2026-09','Otros','a','a',NULL,NULL,NULL),
        ('p','home','expense','personal',5000,'Café','2026-09-02','2026-09','Comida','b','b',NULL,NULL,NULL),
        ('s','home','expense','shared',10001,'Súper','2026-09-03','2026-09','Hogar',NULL,'a','a','2026-09-03T00:00:00.000Z','a'),
        ('q','home','expense','shared',3000,'Luz','2026-09-04','2026-09','Hogar',NULL,'b','b',NULL,NULL)`,
    ], 'write');
    const before = await totals();
    assert.deepEqual(await migrate(old, migrations), ['006_loans.sql']);
    assert.deepEqual(await totals(), before);
  } finally {
    old.close();
    rmSync(upgradeFolder, {recursive: true, force: true});
  }
});
