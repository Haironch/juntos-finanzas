import http from 'node:http';
import {existsSync} from 'node:fs';
import {readFile} from 'node:fs/promises';
import {fromNodeHeaders, toNodeHandler} from 'better-auth/node';
import {createAuth, missingAuthEnv} from './database/auth.mjs';
import {connect, readMigrations} from './database/db.mjs';
import {createApi, json} from './server/api.mjs';

const envFile = new URL('./.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

// En Vercel este archivo se convierte en una función; los archivos de public/ los sirve su CDN.
const ON_VERCEL = Boolean(process.env.VERCEL);
const PORT = Number(process.env.PORT) || 5173;
const ORIGIN = `http://127.0.0.1:${PORT}`;
const files = {'/': 'index.html', '/index.html': 'index.html', '/app.js': 'app.js', '/finance.js': 'finance.js', '/styles.css': 'styles.css', '/favicon.svg': 'favicon.svg'};
const types = {html: 'text/html; charset=utf-8', js: 'text/javascript; charset=utf-8', css: 'text/css; charset=utf-8', svg: 'image/svg+xml'};

// Sin la configuración de sesión la app local sigue funcionando y /api responde 503.
let db, auth, authHandler, handleApi;
const missing = missingAuthEnv();
if (missing.length) {
  console.warn(`Inicio de sesión desactivado: faltan ${missing.join(', ')} en .env.`);
} else {
  db = connect().client;
  auth = createAuth(db);
  authHandler = toNodeHandler(auth);
  handleApi = createApi({
    db,
    getSession: req => auth.api.getSession({headers: fromNodeHeaders(req.headers)}),
    appOrigin: new URL(process.env.BETTER_AUTH_URL).origin,
  });
}
// Solo en local: avisar de configuración y migraciones pendientes (en Vercel las migraciones no viajan con la función).
if (auth && !ON_VERCEL) {
  // Google solo acepta el callback exacto; localhost puede resolver a otro servidor (p. ej. Vite en [::1]).
  if (new URL(process.env.BETTER_AUTH_URL).origin !== ORIGIN) console.warn(`BETTER_AUTH_URL debería ser ${ORIGIN}.`);
  const {rows} = await db.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migrations'");
  const applied = rows.length ? (await db.execute('SELECT name FROM schema_migrations')).rows.map(row => row.name) : [];
  const pending = readMigrations().filter(({name}) => !applied.includes(name));
  if (pending.length) console.warn(`Migraciones pendientes (${pending.map(m => m.name).join(', ')}): ejecutar npm run db:migrate.`);
}

async function api(req, res, pathname) {
  if (!auth) return json(res, 503, {error: 'Inicio de sesión no configurado'});
  // Better Auth lee el cuerpo directamente: no parsearlo antes.
  if (pathname.startsWith('/api/auth/')) return authHandler(req, res);
  return handleApi(req, res, pathname);
}

async function staticFile(res, pathname) {
  const file = files[pathname];
  if (!file) {
    res.writeHead(404);
    return res.end('No encontrado');
  }
  const body = await readFile(new URL('./public/' + file, import.meta.url));
  res.writeHead(200, {'Content-Type': types[file.split('.').pop()], 'Cache-Control': 'no-cache', 'X-Content-Type-Options': 'nosniff'});
  res.end(body);
}

const server = http.createServer(async (req, res) => {
  const {pathname} = new URL(req.url, 'http://localhost');
  try {
    if (pathname.startsWith('/api/')) await api(req, res, pathname);
    else await staticFile(res, pathname);
  } catch (error) {
    console.error(error);
    if (res.headersSent) return res.end();
    if (pathname.startsWith('/api/')) json(res, 500, {error: 'Error del servidor'});
    else {
      res.writeHead(500);
      res.end('No se pudo abrir la aplicación');
    }
  }
});
if (ON_VERCEL) server.listen(PORT);
else server.listen(PORT, '127.0.0.1', () => console.log(`Local: ${ORIGIN}`));
