// Notificaciones push: suscripciones de cada teléfono y avisos a la pareja cuando alguien registra o salda algo.
import webpush from 'web-push';
import {HttpError, memberContext, NOW} from './common.mjs';
import {shareOf} from './finances.mjs';

// Solo servicios de push conocidos: el servidor nunca envía a direcciones arbitrarias.
const PUSH_HOSTS = ['push.apple.com', 'fcm.googleapis.com', 'push.services.mozilla.com', 'notify.windows.com'];
const OTHER = {blue: 'pink', pink: 'blue'};
const money = cents => 'Q ' + (cents / 100).toLocaleString('es-GT', {minimumFractionDigits: 2, maximumFractionDigits: 2});

// Claves VAPID desde las variables de entorno; sin ellas las notificaciones quedan desactivadas.
export function pushConfig(env = process.env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {publicKey: env.VAPID_PUBLIC_KEY, privateKey: env.VAPID_PRIVATE_KEY, subject: env.VAPID_SUBJECT || env.BETTER_AUTH_URL || 'https://juntos-finanzas.vercel.app'};
}

async function requireMember(client, userId) {
  const context = await memberContext(client, userId);
  if (!context) throw new HttpError(403, 'Primero crea un hogar o únete a uno');
  return context;
}

function validEndpoint(value) {
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new HttpError(400, 'Suscripción inválida');
  }
  const known = PUSH_HOSTS.some(host => url.hostname === host || url.hostname.endsWith('.' + host));
  if (url.protocol !== 'https:' || !known || url.href.length > 1000) throw new HttpError(400, 'Servicio de notificaciones no admitido');
  return url.href;
}

export async function saveSubscription(client, userId, body = {}) {
  const endpoint = validEndpoint(body.endpoint);
  const {p256dh, auth} = body.keys || {};
  if (typeof p256dh !== 'string' || !p256dh || p256dh.length > 200 || typeof auth !== 'string' || !auth || auth.length > 100) {
    throw new HttpError(400, 'Suscripción inválida');
  }
  const context = await requireMember(client, userId);
  // Si el teléfono cambia de cuenta, la suscripción pasa a la nueva.
  await client.execute({
    sql: `INSERT INTO push_subscriptions(endpoint, household_id, user_id, p256dh, auth) VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(endpoint) DO UPDATE SET household_id = excluded.household_id, user_id = excluded.user_id,
            p256dh = excluded.p256dh, auth = excluded.auth, updated_at = ${NOW}`,
    args: [endpoint, context.householdId, userId, p256dh, auth],
  });
  return {subscribed: true};
}

export async function deleteSubscription(client, userId, body = {}) {
  await client.execute({sql: 'DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?', args: [String(body.endpoint ?? ''), userId]});
  return {subscribed: false};
}

// Texto para la pareja (recipient) sobre un movimiento que registró author. t viene de la API (posiciones blue/pink).
export function transactionMessage(t, author, names) {
  const who = names[author];
  const recipient = OTHER[author];
  const base = `${t.description} · ${money(t.amountCents)}`;
  if (t.kind === 'income') return {title: `💰 ${who} registró un aporte`, body: base};
  if (t.loan) {
    if (t.paidBy === author) return {title: `${who} pagó algo por ti`, body: `«${t.description}» · ${t.settled ? 'ya se lo devolviste' : `le debes ${money(t.amountCents)}`}`};
    return {title: `${who} registró un préstamo`, body: `Le pagaste «${t.description}» · ${t.settled ? 'ya te lo devolvió' : `te debe ${money(t.amountCents)}`}`};
  }
  if (t.scope === 'shared') {
    if (t.settled) return {title: `${who} registró un gasto compartido`, body: `${base} · mitad y mitad`};
    const owed = money(shareOf(t.amountCents, OTHER[t.paidBy]));
    return {title: `${who} registró un gasto compartido`, body: `${base} · ${t.paidBy === recipient ? `pagaste tú: te debe ${owed}` : `le debes ${owed}`}`};
  }
  return {title: `${who} registró un gasto`, body: t.owner === recipient ? `${base} · a tu nombre` : base};
}

export function settleMessage(items, author, names) {
  const who = names[author];
  const total = items.reduce((sum, t) => sum + t.pendingCents, 0);
  if (items.length === 1) {
    const [t] = items;
    return {title: `✅ ${who} marcó ${t.loan ? 'un préstamo como devuelto' : 'un pendiente como saldado'}`, body: `«${t.description}» · ${money(total)}`};
  }
  return {title: `✅ ${who} saldó ${items.length} pendientes`, body: `${money(total)} en total`};
}

// send(subscription, payload) se puede reemplazar en pruebas; por defecto usa web-push con las claves VAPID.
export function createNotifier({client, config, send}) {
  const deliver = send ?? ((subscription, payload) => webpush.sendNotification(subscription, payload, {
    vapidDetails: {subject: config.subject, publicKey: config.publicKey, privateKey: config.privateKey},
    TTL: 60 * 60 * 24,
    urgency: 'normal',
  }));

  async function notifyPartner(userId, build) {
    const context = await memberContext(client, userId);
    if (!context || context.members < 2) return 0;
    const {rows: subscriptions} = await client.execute({
      sql: 'SELECT endpoint, p256dh, auth FROM push_subscriptions WHERE household_id = ? AND user_id <> ?',
      args: [context.householdId, userId],
    });
    if (!subscriptions.length) return 0;
    const {rows: members} = await client.execute({sql: 'SELECT slot, display_name FROM household_members WHERE household_id = ?', args: [context.householdId]});
    const names = Object.fromEntries(members.map(m => [m.slot, m.display_name]));
    const message = build(context.mySlot, names);
    const payload = JSON.stringify({...message, url: '/', tag: message.tag || `juntos-${Date.now()}`});
    const results = await Promise.allSettled(subscriptions.map(s => deliver({endpoint: s.endpoint, keys: {p256dh: s.p256dh, auth: s.auth}}, payload)));
    // El servicio responde 404/410 cuando el teléfono quitó el permiso o desinstaló la app: se limpia.
    await Promise.all(results.map((result, i) => {
      const status = result.reason?.statusCode;
      return status === 404 || status === 410
        ? client.execute({sql: 'DELETE FROM push_subscriptions WHERE endpoint = ?', args: [subscriptions[i].endpoint]})
        : null;
    }));
    return results.filter(r => r.status === 'fulfilled').length;
  }

  return {
    transactionCreated: (userId, t) => notifyPartner(userId, (author, names) => ({...transactionMessage(t, author, names), tag: `tx-${t.id}`})),
    settled: (userId, items) => items.length ? notifyPartner(userId, (author, names) => settleMessage(items, author, names)) : 0,
  };
}
