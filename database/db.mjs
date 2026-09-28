// Solo servidor: el token de Turso nunca debe llegar a public/ ni al navegador.
import {createHash} from 'node:crypto';
import {mkdirSync, readdirSync, readFileSync} from 'node:fs';
import {createClient} from '@libsql/client';

const ROOT = new URL('../', import.meta.url);
const MIGRATIONS = new URL('database/migrations/', ROOT);
export const LOCAL_URL = new URL('.data/juntos.db', ROOT).href;

// Sin TURSO_DATABASE_URL se usa la base local .data/juntos.db.
export function connect(env = process.env) {
  // En Vercel no hay disco persistente: la base local no sirve y se exige Turso.
  if (env.VERCEL && !env.TURSO_DATABASE_URL) throw new Error('Falta TURSO_DATABASE_URL en las variables de entorno de Vercel');
  const url = env.TURSO_DATABASE_URL || LOCAL_URL;
  if (url === LOCAL_URL) mkdirSync(new URL('.data/', ROOT), {recursive: true});
  const remote = !url.startsWith('file:') && url !== ':memory:';
  if (remote && !env.TURSO_AUTH_TOKEN) throw new Error('Falta TURSO_AUTH_TOKEN para la base remota');
  return {client: createClient({url, authToken: remote ? env.TURSO_AUTH_TOKEN : undefined}), url, remote};
}

export function readMigrations() {
  return readdirSync(MIGRATIONS).filter(name => name.endsWith('.sql')).sort().map(name => {
    const sql = readFileSync(new URL(name, MIGRATIONS), 'utf8');
    return {name, sql, sha256: createHash('sha256').update(sql).digest('hex')};
  });
}

// Aplica cada migración pendiente en su propia transacción de escritura.
// El checksum se lee dentro de la transacción: dos ejecuciones simultáneas no aplican lo mismo dos veces.
export async function migrate(client, migrations = readMigrations()) {
  const {rows: [fk]} = await client.execute('PRAGMA foreign_keys');
  if (Number(fk.foreign_keys) !== 1) throw new Error('La conexión no aplica claves foráneas (PRAGMA foreign_keys=0)');
  await client.execute('CREATE TABLE IF NOT EXISTS schema_migrations (name TEXT PRIMARY KEY, sha256 TEXT NOT NULL, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const applied = [];
  for (const {name, sql, sha256} of migrations) {
    const tx = await client.transaction('write');
    try {
      const {rows: [previous]} = await tx.execute({sql: 'SELECT sha256 FROM schema_migrations WHERE name = ?', args: [name]});
      if (previous) {
        if (previous.sha256 !== sha256) throw new Error(`Migración ya aplicada modificada: ${name}`);
        await tx.rollback();
        continue;
      }
      await tx.executeMultiple(sql);
      await tx.execute({sql: 'INSERT INTO schema_migrations(name, sha256) VALUES (?, ?)', args: [name, sha256]});
      await tx.commit();
      applied.push(name);
    } finally {
      tx.close();
    }
  }
  const {rows: problems} = await client.execute('PRAGMA foreign_key_check');
  if (problems.length) throw new Error(`Referencias inválidas tras migrar: ${problems.length}`);
  return applied;
}
