import assert from 'node:assert/strict';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, test} from 'node:test';
import {createClient} from '@libsql/client';
import {createAuth, missingAuthEnv, resolveUser} from '../database/auth.mjs';
import {migrate} from '../database/db.mjs';

// Valores ficticios: no se contacta a Google en estas pruebas.
const env = {
  BETTER_AUTH_SECRET: 'prueba-secreto-local-con-longitud-suficiente-0123456789',
  BETTER_AUTH_URL: 'http://127.0.0.1:5173',
  GOOGLE_CLIENT_ID: 'cliente-de-prueba',
  GOOGLE_CLIENT_SECRET: 'secreto-de-prueba',
  ALLOWED_EMAILS: 'Azul@Ejemplo.com, rosa@ejemplo.com',
};
let folder, db;

beforeEach(async () => {
  folder = mkdtempSync(join(tmpdir(), 'juntos-auth-'));
  db = createClient({url: 'file:' + join(folder, 'test.db')});
  await migrate(db);
});

afterEach(() => {
  db.close();
  rmSync(folder, {recursive: true, force: true});
});

test('detecta variables de sesión faltantes', () => {
  assert.deepEqual(missingAuthEnv(env), []);
  assert.deepEqual(missingAuthEnv({...env, GOOGLE_CLIENT_SECRET: ''}), ['GOOGLE_CLIENT_SECRET']);
});

test('solo permite crear cuenta a correos verificados de la lista', async () => {
  const before = createAuth(db, env).options.databaseHooks.user.create.before;
  assert.deepEqual(await before({email: 'azul@ejemplo.com', emailVerified: true}), {data: {email: 'azul@ejemplo.com', emailVerified: true}});
  await assert.rejects(before({email: 'otra@ejemplo.com', emailVerified: true}), /no tiene acceso/);
  await assert.rejects(before({email: 'rosa@ejemplo.com', emailVerified: false}), /no tiene acceso/);
});

test('el inicio con Google redirige a accounts.google.com con el callback configurado', async () => {
  const auth = createAuth(db, env);
  const response = await auth.handler(new Request('http://127.0.0.1:5173/api/auth/sign-in/social', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', Origin: 'http://127.0.0.1:5173'},
    body: JSON.stringify({provider: 'google', callbackURL: '/'}),
  }));
  assert.equal(response.status, 200);
  const url = new URL((await response.json()).url);
  assert.equal(url.host, 'accounts.google.com');
  assert.equal(url.searchParams.get('redirect_uri'), 'http://127.0.0.1:5173/api/auth/callback/google');
});

test('rechaza redirecciones y peticiones con cookie desde otros orígenes', async () => {
  const auth = createAuth(db, env);
  const signIn = (headers, callbackURL = '/') => auth.handler(new Request('http://127.0.0.1:5173/api/auth/sign-in/social', {
    method: 'POST',
    headers: {'Content-Type': 'application/json', ...headers},
    body: JSON.stringify({provider: 'google', callbackURL}),
  }));
  assert.equal((await signIn({Origin: 'http://127.0.0.1:5173'}, 'https://sitio-ajeno.example/')).status, 403);
  assert.equal((await signIn({Origin: 'https://sitio-ajeno.example', Cookie: 'x=1'})).status, 403);
});

test('vincula la cuenta de Better Auth con users una sola vez', async () => {
  const first = await resolveUser(db, 'auth-azul');
  assert.equal(await resolveUser(db, 'auth-azul'), first);
  assert.notEqual(await resolveUser(db, 'auth-rosa'), first);
  assert.equal((await db.execute('SELECT count(*) AS n FROM users')).rows[0].n, 2);
});
