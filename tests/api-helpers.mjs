// API real sobre HTTP con base temporal; la sesión se simula con el encabezado x-test-user en lugar de Google.
import {mkdtempSync, rmSync} from 'node:fs';
import http from 'node:http';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createClient} from '@libsql/client';
import {migrate} from '../database/db.mjs';
import {createNotifier} from '../database/push.mjs';
import {createApi} from '../server/api.mjs';

export const ORIGIN = 'http://app.test';

// send: enviador falso de notificaciones (recibe suscripción y mensaje); sin él no hay notificaciones.
export async function startApi({send, pushPublicKey} = {}) {
  const folder = mkdtempSync(join(tmpdir(), 'juntos-api-'));
  const db = createClient({url: 'file:' + join(folder, 'test.db')});
  await migrate(db);
  const handle = createApi({
    db,
    appOrigin: ORIGIN,
    notifier: send && createNotifier({client: db, config: {}, send}),
    pushPublicKey,
    getSession: async req => req.headers['x-test-user'] ? {user: {id: req.headers['x-test-user'], name: 'Prueba', email: 'p@ejemplo.com', image: null}} : null,
  });
  const server = http.createServer((req, res) => handle(req, res, new URL(req.url, 'http://x').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;

  async function call(user, method, path, body, headers = {}) {
    const response = await fetch(base + path, {
      method,
      headers: {...(user && {'x-test-user': user}), ...(method !== 'GET' && {Origin: ORIGIN, 'Content-Type': 'application/json'}), ...headers},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return {status: response.status, body: await response.json()};
  }

  // Hogar con azul (quien lo crea) y rosa (quien se une).
  async function couple(blue = 'azul', pink = 'rosa') {
    await call(blue, 'POST', '/api/household', {name: 'Casa', displayName: 'Hairon'});
    const {body: {code}} = await call(blue, 'POST', '/api/household/invite', {});
    return call(pink, 'POST', '/api/household/join', {code, displayName: 'Pareja'});
  }

  async function stop() {
    await new Promise(resolve => server.close(resolve));
    db.close();
    rmSync(folder, {recursive: true, force: true});
  }

  return {db, call, couple, stop};
}
