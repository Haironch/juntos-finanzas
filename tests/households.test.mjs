import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop;
beforeEach(async () => ({db, call, couple, stop} = await startApi()));
afterEach(() => stop());

test('sin sesión responde 401 y sin hogar devuelve household null', async () => {
  assert.equal((await call(null, 'GET', '/api/me')).status, 401);
  assert.deepEqual((await call('azul', 'GET', '/api/me')).body.household, null);
});

test('crear hogar, invitar y unirse con colores distintos predefinidos', async () => {
  const created = await call('azul', 'POST', '/api/household', {name: ' Casa ', displayName: 'Hairon'});
  assert.equal(created.status, 200);
  assert.deepEqual(created.body.members, [{displayName: 'Hairon', slot: 'blue', color: 'blue', isMe: true}]);
  const invite = await call('azul', 'POST', '/api/household/invite', {});
  assert.match(invite.body.code, /^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
  // El código se acepta sin guiones y en minúsculas.
  const joined = await call('rosa', 'POST', '/api/household/join', {code: invite.body.code.replaceAll('-', '').toLowerCase(), displayName: 'Pareja'});
  assert.equal(joined.status, 200);
  assert.equal(joined.body.name, 'Casa');
  assert.deepEqual(joined.body.members.map(({color, slot, isMe}) => [color, slot, isMe]), [['blue', 'blue', false], ['pink', 'pink', true]]);
  assert.equal((await call('azul', 'GET', '/api/me')).body.household.members.length, 2);
});

test('el código es de un solo uso y no admite un tercer miembro', async () => {
  await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'Hairon'});
  const {body: {code}} = await call('azul', 'POST', '/api/household/invite', {});
  await call('rosa', 'POST', '/api/household/join', {code, displayName: 'Pareja'});
  assert.equal((await call('tercero', 'POST', '/api/household/join', {code, displayName: 'Otra'})).status, 400);
  assert.equal((await call('azul', 'POST', '/api/household/invite', {})).status, 409);
});

test('un código nuevo invalida el anterior; códigos vencidos o inventados se rechazan', async () => {
  await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'Hairon'});
  const old = (await call('azul', 'POST', '/api/household/invite', {})).body.code;
  const current = (await call('azul', 'POST', '/api/household/invite', {})).body.code;
  assert.equal((await call('rosa', 'POST', '/api/household/join', {code: old, displayName: 'Pareja'})).status, 400);
  assert.equal((await call('rosa', 'POST', '/api/household/join', {code: 'AAAA-BBBB-CCCC', displayName: 'Pareja'})).status, 400);
  await db.execute("UPDATE household_invites SET expires_at = '2000-01-01T00:00:00.000Z'");
  const expired = await call('rosa', 'POST', '/api/household/join', {code: current, displayName: 'Pareja'});
  assert.deepEqual(expired, {status: 400, body: {error: 'Código inválido o vencido'}});
});

test('no se puede crear ni unirse a un segundo hogar', async () => {
  await couple();
  assert.equal((await call('azul', 'POST', '/api/household', {name: 'Otra', displayName: 'Hairon'})).status, 409);
  await call('otro', 'POST', '/api/household', {name: 'Otra casa', displayName: 'Otro'});
  const {body: {code}} = await call('otro', 'POST', '/api/household/invite', {});
  assert.equal((await call('rosa', 'POST', '/api/household/join', {code, displayName: 'Pareja'})).status, 409);
});

test('cada quien edita su nombre y color, siempre distinto al de su pareja', async () => {
  await couple();
  const changed = await call('rosa', 'PATCH', '/api/household/me', {color: 'purple', displayName: 'Ella'});
  assert.equal(changed.status, 200);
  assert.deepEqual(changed.body.members.find(m => m.isMe), {displayName: 'Ella', slot: 'pink', color: 'purple', isMe: true});
  assert.deepEqual(await call('azul', 'PATCH', '/api/household/me', {color: 'purple'}), {status: 409, body: {error: 'Ese color ya lo usa tu pareja; elige otro'}});
  assert.equal((await call('azul', 'PATCH', '/api/household/me', {color: 'pink'})).status, 200);
  assert.equal((await call('azul', 'PATCH', '/api/household/me', {color: 'rojo'})).status, 400);
  assert.equal((await call('azul', 'PATCH', '/api/household/me', {displayName: ' '.repeat(3)})).status, 400);
  assert.equal((await call('azul', 'PATCH', '/api/household/me', {})).status, 400);
  // El índice único también lo impide si alguien escribe directo en la base.
  await assert.rejects(db.execute("UPDATE household_members SET color = 'purple' WHERE slot = 'blue'"), {code: /^SQLITE_CONSTRAINT/});
});

test('cambiar colores no altera el reparto del centavo impar', async () => {
  await couple();
  const {rows: [home]} = await db.execute('SELECT id FROM households');
  const {rows: [blue]} = await db.execute("SELECT user_id FROM household_members WHERE slot = 'blue'");
  await db.execute({
    sql: `INSERT INTO transactions(id,household_id,kind,scope,amount_cents,description,occurred_on,category,created_by,paid_by,settled_at,settled_by)
          VALUES ('t',?,'expense','shared',101,'Súper','2026-09-28','Supermercado',?,?,'2026-09-28T00:00:00.000Z',?)`,
    args: [home.id, blue.user_id, blue.user_id, blue.user_id],
  });
  await call('azul', 'PATCH', '/api/household/me', {color: 'teal'});
  await call('rosa', 'PATCH', '/api/household/me', {color: 'blue'});
  const {rows} = await db.execute('SELECT slot, signed_amount_cents FROM transaction_allocations ORDER BY slot');
  assert.deepEqual(rows.map(row => [row.slot, row.signed_amount_cents]), [['blue', -50], ['pink', -51]]);
});

test('rechaza otros orígenes, cuerpos que no son JSON y rutas desconocidas', async () => {
  assert.equal((await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'H'}, {Origin: 'https://ajeno.example'})).status, 403);
  assert.equal((await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'H'}, {Origin: ''})).status, 403);
  assert.equal((await call('azul', 'POST', '/api/household', {name: 'Casa', displayName: 'H'}, {'Content-Type': 'text/plain'})).status, 415);
  assert.equal((await call('azul', 'POST', '/api/household', {x: 'y'.repeat(20_000)})).status, 413);
  assert.equal((await call('azul', 'DELETE', '/api/household')).status, 404);
  assert.equal((await call('azul', 'GET', '/api/household')).status, 404);
});
