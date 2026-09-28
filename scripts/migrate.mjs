// Uso: npm run db:migrate. Lee .env si existe; sin TURSO_DATABASE_URL migra la base local.
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {connect, migrate} from '../database/db.mjs';

const envFile = new URL('../.env', import.meta.url);
if (existsSync(envFile)) process.loadEnvFile(envFile);

let client, target = 'la base';
try {
  const connection = connect();
  client = connection.client;
  // Solo se muestra el host, nunca el token.
  target = connection.remote ? new URL(connection.url).host : fileURLToPath(connection.url);
  const applied = await migrate(client);
  console.log(`${connection.remote ? 'Turso' : 'Local'} (${target}): ${applied.length ? 'aplicadas ' + applied.join(', ') : 'sin migraciones pendientes'}.`);
} catch (error) {
  console.error(`No se pudo migrar ${target}: ${error.message}`);
  process.exitCode = 1;
} finally {
  client?.close();
}
