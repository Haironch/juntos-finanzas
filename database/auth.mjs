// Solo servidor. Inicio de sesión con Google mediante Better Auth; sesiones guardadas en la misma base libSQL.
import {randomUUID} from 'node:crypto';
import {LibsqlDialect} from '@libsql/kysely-libsql';
import {betterAuth} from 'better-auth';
import {APIError} from 'better-auth/api';

export const AUTH_ISSUER = 'better-auth';
export const REQUIRED_ENV = ['BETTER_AUTH_SECRET', 'BETTER_AUTH_URL', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET', 'ALLOWED_EMAILS'];

export const missingAuthEnv = (env = process.env) => REQUIRED_ENV.filter(name => !env[name]);

export const allowedEmails = (env = process.env) =>
  new Set((env.ALLOWED_EMAILS || '').split(',').map(email => email.trim().toLowerCase()).filter(Boolean));

// Tablas propias de Better Auth con prefijo auth_ para no confundirlas con las de Juntos.
export const authModels = {
  user: {modelName: 'auth_users'},
  session: {modelName: 'auth_sessions'},
  account: {modelName: 'auth_accounts', encryptOAuthTokens: true},
  verification: {modelName: 'auth_verifications'},
};

export function createAuth(client, env = process.env) {
  const allowed = allowedEmails(env);
  return betterAuth({
    appName: 'Juntos',
    baseURL: env.BETTER_AUTH_URL,
    secret: env.BETTER_AUTH_SECRET,
    database: {dialect: new LibsqlDialect({client}), type: 'sqlite'},
    ...authModels,
    socialProviders: {
      google: {clientId: env.GOOGLE_CLIENT_ID, clientSecret: env.GOOGLE_CLIENT_SECRET, prompt: 'select_account'},
    },
    // Solo los correos de ALLOWED_EMAILS pueden crear cuenta; es una app privada.
    databaseHooks: {
      user: {
        create: {
          before: async user => {
            if (!user.emailVerified || !allowed.has(user.email.toLowerCase())) {
              throw new APIError('FORBIDDEN', {message: 'Este correo no tiene acceso a Juntos'});
            }
            return {data: user};
          },
        },
      },
    },
    telemetry: {enabled: false},
  });
}

// Vincula la cuenta de Better Auth con la identidad de Juntos (tabla users) y su hogar, si ya pertenece a uno.
export async function resolveMember(client, authUserId) {
  await client.execute({
    sql: 'INSERT INTO users(id, auth_issuer, auth_subject) VALUES (?, ?, ?) ON CONFLICT(auth_issuer, auth_subject) DO NOTHING',
    args: [randomUUID(), AUTH_ISSUER, authUserId],
  });
  const {rows: [row]} = await client.execute({
    sql: `SELECT u.id AS user_id, m.household_id, m.slot, m.display_name
          FROM users u LEFT JOIN household_members m ON m.user_id = u.id
          WHERE u.auth_issuer = ? AND u.auth_subject = ?`,
    args: [AUTH_ISSUER, authUserId],
  });
  return {
    userId: row.user_id,
    member: row.household_id ? {householdId: row.household_id, slot: row.slot, displayName: row.display_name} : null,
  };
}
