// Rutas propias de Juntos. getSession se inyecta para poder probar sin Google.
import {resolveUser} from '../database/auth.mjs';
import {HttpError} from '../database/common.mjs';
import {createTransaction, deleteGoal, deleteTransaction, getMonth, saveGoal, updateTransaction} from '../database/finances.mjs';
import {createHousehold, createInvite, getHousehold, joinHousehold, updateMember} from '../database/households.mjs';

const MAX_BODY = 10_000;

export function json(res, status, body) {
  res.writeHead(status, {'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff'});
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  if (!(req.headers['content-type'] || '').startsWith('application/json')) throw new HttpError(415, 'Se esperaba JSON');
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY) throw new HttpError(413, 'Solicitud demasiado grande');
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}');
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body;
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function createApi({db, getSession, appOrigin}) {
  // [método, ruta con :parámetros, acción]. Los parámetros solo aceptan letras, números y guiones.
  const routes = [
    ['GET', '/api/me', async ({session, userId}) => {
      const {name, email, image} = session.user;
      return {user: {name, email, image}, household: await getHousehold(db, userId)};
    }],
    ['POST', '/api/household', ({userId, body}) => createHousehold(db, userId, body)],
    ['PATCH', '/api/household/me', ({userId, body}) => updateMember(db, userId, body)],
    ['POST', '/api/household/invite', ({userId}) => createInvite(db, userId)],
    ['POST', '/api/household/join', ({userId, body}) => joinHousehold(db, userId, body)],
    ['GET', '/api/months/:month', ({userId, params}) => getMonth(db, userId, params.month)],
    ['PUT', '/api/months/:month/goal', ({userId, params, body}) => saveGoal(db, userId, params.month, body)],
    ['DELETE', '/api/months/:month/goal', ({userId, params, body}) => deleteGoal(db, userId, params.month, body)],
    ['POST', '/api/transactions', ({userId, body}) => createTransaction(db, userId, body)],
    ['PATCH', '/api/transactions/:id', ({userId, params, body}) => updateTransaction(db, userId, params.id, body)],
    ['DELETE', '/api/transactions/:id', ({userId, params, body}) => deleteTransaction(db, userId, params.id, body)],
  ].map(([method, path, action]) => ({
    method,
    action,
    pattern: new RegExp('^' + path.replace(/:(\w+)/g, '(?<$1>[A-Za-z0-9-]{1,64})') + '$'),
  }));

  function match(method, pathname) {
    for (const route of routes) {
      const found = route.method === method && route.pattern.exec(pathname);
      if (found) return {action: route.action, params: {...found.groups}};
    }
    return null;
  }

  return async function handle(req, res, pathname) {
    const route = match(req.method, pathname);
    if (!route) return json(res, 404, {error: 'No encontrado'});
    try {
      // Las cookies de sesión viajan solas: exigir el mismo origen y JSON evita peticiones desde otros sitios.
      if (req.method !== 'GET' && req.headers.origin !== appOrigin) throw new HttpError(403, 'Origen no permitido');
      const session = await getSession(req);
      if (!session) throw new HttpError(401, 'Inicia sesión para continuar');
      const body = req.method === 'GET' ? undefined : await readJson(req);
      const userId = await resolveUser(db, session.user.id);
      json(res, 200, await route.action({session, userId, body, params: route.params}));
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, {error: error.message, ...error.details});
      throw error;
    }
  };
}
