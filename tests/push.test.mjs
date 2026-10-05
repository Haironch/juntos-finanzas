import assert from 'node:assert/strict';
import {afterEach, beforeEach, test} from 'node:test';
import {settleMessage, transactionMessage} from '../database/push.mjs';
import {startApi} from './api-helpers.mjs';

let db, call, couple, stop, sent, failWith;
beforeEach(async () => {
  sent = [];
  failWith = null;
  const send = async (subscription, payload) => {
    if (failWith) throw Object.assign(new Error('push falló'), {statusCode: failWith});
    sent.push({endpoint: subscription.endpoint, ...JSON.parse(payload)});
  };
  ({db, call, couple, stop} = await startApi({send, pushPublicKey: 'clave-publica-de-prueba'}));
});
afterEach(() => stop());

const apple = id => `https://web.push.apple.com/QH${id}`;
const subscribe = (user, endpoint) => call(user, 'POST', '/api/push/subscribe', {endpoint, keys: {p256dh: 'BPclave', auth: 'secreto'}});
const add = (user, body) => call(user, 'POST', '/api/transactions', body);
const expense = (props = {}) => ({kind: 'expense', scope: 'shared', amountCents: 35000, description: 'Súper', occurredOn: '2026-10-02', category: 'Supermercado', ...props});

test('solo la pareja recibe el aviso de lo que uno registra', async () => {
  await couple();
  await subscribe('azul', apple('hairon-iphone'));
  await subscribe('rosa', apple('mayra-iphone'));
  await add('rosa', expense());
  assert.equal(sent.length, 1);
  assert.equal(sent[0].endpoint, apple('hairon-iphone'));
  assert.equal(sent[0].title, 'Pareja registró un gasto compartido');
  assert.equal(sent[0].body, 'Súper · Q 350.00 · le debes Q 175.00');
  assert.equal(sent[0].url, '/');
  assert.match(sent[0].tag, /^tx-/);
});

test('sin suscripciones no se envía nada y el registro funciona igual', async () => {
  await couple();
  assert.equal((await add('rosa', expense())).status, 200);
  assert.equal(sent.length, 0);
});

test('si el servicio de push falla, el gasto se guarda igual; 410 borra la suscripción', async () => {
  await couple();
  await subscribe('azul', apple('viejo'));
  failWith = 500;
  assert.equal((await add('rosa', expense())).status, 200);
  assert.equal((await db.execute('SELECT count(*) AS n FROM push_subscriptions')).rows[0].n, 1);
  failWith = 410;
  assert.equal((await add('rosa', expense())).status, 200);
  assert.equal((await db.execute('SELECT count(*) AS n FROM push_subscriptions')).rows[0].n, 0);
});

test('avisa al saldar pendientes', async () => {
  await couple();
  await subscribe('azul', apple('hairon'));
  const t = (await add('azul', expense({amountCents: 10001}))).body;
  await call('rosa', 'POST', '/api/pending/settle', {items: [{id: t.id, version: t.version}]});
  assert.deepEqual(sent.map(m => [m.title, m.body]), [['✅ Pareja marcó un pendiente como saldado', '«Súper» · Q 50.01']]);
});

test('valida la suscripción y solo acepta servicios de push conocidos', async () => {
  await couple();
  for (const endpoint of ['http://web.push.apple.com/x', 'https://evil.example/push', 'https://push.apple.com.evil.example/x', 'no es url']) {
    assert.equal((await subscribe('azul', endpoint)).status, 400, endpoint);
  }
  assert.equal((await call('azul', 'POST', '/api/push/subscribe', {endpoint: apple('x'), keys: {}})).status, 400);
  for (const endpoint of [apple('a'), 'https://fcm.googleapis.com/fcm/send/abc', 'https://updates.push.services.mozilla.com/wpush/v2/abc']) {
    assert.equal((await subscribe('azul', endpoint)).status, 200, endpoint);
  }
});

test('un teléfono que cambia de cuenta pasa a avisar a la nueva y cada quien borra solo la suya', async () => {
  await couple();
  await subscribe('azul', apple('compartido'));
  await subscribe('rosa', apple('compartido'));
  assert.equal((await db.execute('SELECT count(*) AS n FROM push_subscriptions')).rows[0].n, 1);
  await call('azul', 'DELETE', '/api/push/subscribe', {endpoint: apple('compartido')});
  assert.equal((await db.execute('SELECT count(*) AS n FROM push_subscriptions')).rows[0].n, 1);
  await call('rosa', 'DELETE', '/api/push/subscribe', {endpoint: apple('compartido')});
  assert.equal((await db.execute('SELECT count(*) AS n FROM push_subscriptions')).rows[0].n, 0);
});

test('entrega la clave pública para suscribirse', async () => {
  await couple();
  assert.deepEqual((await call('azul', 'GET', '/api/push/key')).body, {publicKey: 'clave-publica-de-prueba'});
  const plain = await startApi();
  await plain.couple();
  assert.equal((await plain.call('azul', 'GET', '/api/push/key')).status, 503);
  await plain.stop();
});

test('textos de cada tipo de movimiento, desde el punto de vista de la pareja', () => {
  const names = {blue: 'Hairon', pink: 'Mayra'};
  const t = (props) => ({description: 'Algo', amountCents: 10001, ...props});
  const message = (props, author = 'pink') => transactionMessage(t(props), author, names);
  assert.deepEqual(message({kind: 'income', scope: 'personal', owner: 'pink'}), {title: '💰 Mayra registró un aporte', body: 'Algo · Q 100.01'});
  assert.equal(message({kind: 'expense', scope: 'personal', owner: 'pink'}).body, 'Algo · Q 100.01');
  assert.equal(message({kind: 'expense', scope: 'personal', owner: 'blue'}).body, 'Algo · Q 100.01 · a tu nombre');
  assert.equal(message({kind: 'expense', scope: 'shared', paidBy: 'pink', settled: false}).body, 'Algo · Q 100.01 · le debes Q 50.00');
  assert.equal(message({kind: 'expense', scope: 'shared', paidBy: 'blue', settled: false}).body, 'Algo · Q 100.01 · pagaste tú: te debe Q 50.01');
  assert.equal(message({kind: 'expense', scope: 'shared', paidBy: 'pink', settled: true}).body, 'Algo · Q 100.01 · mitad y mitad');
  assert.deepEqual(message({kind: 'expense', scope: 'personal', owner: 'blue', loan: true, paidBy: 'pink', settled: false}), {title: 'Mayra pagó algo por ti', body: '«Algo» · le debes Q 100.01'});
  assert.deepEqual(message({kind: 'expense', scope: 'personal', owner: 'pink', loan: true, paidBy: 'blue', settled: false}), {title: 'Mayra registró un préstamo', body: 'Le pagaste «Algo» · te debe Q 100.01'});
  assert.deepEqual(settleMessage([{description: 'Luz', pendingCents: 60000, loan: false}, {description: 'Cena', pendingCents: 22525}], 'pink', names), {title: '✅ Mayra saldó 2 pendientes', body: 'Q 825.25 en total'});
});

test('web-push arma una petición cifrada válida con claves VAPID reales', async () => {
  const {default: webpush} = await import('web-push');
  const {createECDH, randomBytes} = await import('node:crypto');
  const vapid = webpush.generateVAPIDKeys();
  const phone = createECDH('prime256v1');
  phone.generateKeys();
  const subscription = {endpoint: apple('real'), keys: {p256dh: phone.getPublicKey('base64url'), auth: randomBytes(16).toString('base64url')}};
  const request = webpush.generateRequestDetails(subscription, JSON.stringify({title: 'Hola', body: 'Prueba'}), {
    vapidDetails: {subject: 'https://juntos-finanzas.vercel.app', publicKey: vapid.publicKey, privateKey: vapid.privateKey},
    TTL: 60,
  });
  assert.equal(request.method, 'POST');
  assert.equal(request.headers['Content-Encoding'], 'aes128gcm');
  assert.match(request.headers.Authorization, /^vapid t=.+, k=.+$/);
  assert.ok(request.body.length > 40);
});
