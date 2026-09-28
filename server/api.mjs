// Rutas propias de Juntos. getSession se inyecta para poder probar sin Google.
import {resolveUser} from '../database/auth.mjs';
import {createHousehold, createInvite, getHousehold, HttpError, joinHousehold, updateMember} from '../database/households.mjs';

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
  const routes = {
    'GET /api/me': async ({session, userId}) => {
      const {name, email, image} = session.user;
      return {user: {name, email, image}, household: await getHousehold(db, userId)};
    },
    'POST /api/household': ({userId, body}) => createHousehold(db, userId, body),
    'PATCH /api/household/me': ({userId, body}) => updateMember(db, userId, body),
    'POST /api/household/invite': ({userId}) => createInvite(db, userId),
    'POST /api/household/join': ({userId, body}) => joinHousehold(db, userId, body),
  };

  return async function handle(req, res, pathname) {
    const route = routes[`${req.method} ${pathname}`];
    if (!route) return json(res, 404, {error: 'No encontrado'});
    try {
      // Las cookies de sesión viajan solas: exigir el mismo origen y JSON evita peticiones desde otros sitios.
      if (req.method !== 'GET' && req.headers.origin !== appOrigin) throw new HttpError(403, 'Origen no permitido');
      const session = await getSession(req);
      if (!session) throw new HttpError(401, 'Inicia sesión para continuar');
      const body = req.method === 'GET' ? undefined : await readJson(req);
      const userId = await resolveUser(db, session.user.id);
      json(res, 200, await route({session, userId, body}));
    } catch (error) {
      if (error instanceof HttpError) return json(res, error.status, {error: error.message});
      throw error;
    }
  };
}
