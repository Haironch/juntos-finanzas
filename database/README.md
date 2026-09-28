# Base de datos de Juntos

Estado: migraciones 001 (datos) y 002 (sesiones) probadas con el cliente libSQL (`@libsql/client`) sobre un archivo local. Inicio de sesión con Google (Better Auth) y `GET /api/me` listos en el servidor. Todavía NO se aplicó en Turso, NO hay endpoints de hogar/movimientos y la interfaz sigue usando el guardado del navegador.

## Modelo

| Tabla | Propósito |
| --- | --- |
| users | Identidad de Juntos: emisor `better-auth` y sujeto = id de `auth_users`. Se crea al consultar `/api/me`. Sin contraseñas. |
| households | Espacio privado, moneda GTQ y zona horaria. |
| household_members | Hasta dos miembros por hogar, posiciones azul/rosa y nombres visibles. Cada usuario pertenece a un hogar. |
| transactions | Ingresos y gastos, dueño, autor, categoría y fecha local. |
| monthly_goals | Una meta por hogar y mes. |
| auth_users, auth_sessions, auth_accounts, auth_verifications | Tablas de Better Auth (columnas camelCase). Tokens OAuth cifrados. |
| schema_migrations | Registro de migraciones y sus checksums. |

Un hogar puede tener un solo miembro durante la configuración, pero requiere dos para registrar un gasto compartido. La identidad/color de los miembros no cambia: eso evitará alterar los repartos históricos. Los nombres sí se pueden editar.

`transaction_allocations` es una vista calculada: ingresos positivos, gastos negativos, compartidos por mitad y centavo impar para rosa. Un gasto de Q 100.01 genera -5000 y -5001 centavos. No se almacenan saldos acumulados ni se descuentan las metas. Se filtra cada mes por fechas locales, sin arrastre automático.

## Ejecutar

```sh
npm install
npm run db:migrate   # sin .env: .data/juntos.db; con TURSO_DATABASE_URL y TURSO_AUTH_TOKEN: Turso
npm test
```

`database/db.mjs` aplica cada migración pendiente en una transacción de escritura, registra su checksum en `schema_migrations`, rechaza migraciones ya aplicadas que fueron modificadas, exige `PRAGMA foreign_keys=1` (libSQL lo activa por defecto) y ejecuta `PRAGMA foreign_key_check` al final. No carga datos de ejemplo. No editar migraciones que ya estén aplicadas: agregar una nueva.

## Inicio de sesión

Better Auth con Google, montado en `/api/auth/*` por `server.mjs` y configurado en `database/auth.mjs`:

- Solo los correos verificados de `ALLOWED_EMAILS` pueden crear cuenta.
- Sesión en cookie httpOnly; las sesiones se guardan en `auth_sessions` de la misma base.
- Protección de redirecciones y peticiones con cookie desde otros orígenes (Better Auth).
- `GET /api/me` devuelve `{user, member}`; `member` es `null` mientras la persona no pertenezca a un hogar.
- Sin las variables de `.env.example`, el servidor sigue sirviendo la app local y `/api` responde 503.

Configurar Google: Google Cloud Console > APIs y servicios > Credenciales > Crear ID de cliente OAuth (aplicación web), con el URI de redirección `http://127.0.0.1:5173/api/auth/callback/google` (y después el de producción). Usar `127.0.0.1`, no `localhost`: en este equipo `localhost` puede resolver a otro servidor en el mismo puerto.

## Integración pendiente

1. Aplicar las migraciones en una base de desarrollo de Turso (`npm run db:migrate` con `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` en `.env`), luego en producción. Nunca poner esas variables en `dist/`, Git ni el navegador.
2. Crear el hogar e invitar a la pareja: la primera persona crea el hogar (azul o rosa) y la segunda se une con un código de un solo uso. Definir antes cómo se eligen los colores.
3. API de movimientos y metas: `household_id` y `created_by` salen siempre de la sesión, nunca del navegador. Una FK valida pertenencia, NO reemplaza autorización. Consultas parametrizadas acotadas al hogar; editar con `WHERE household_id=? AND id=? AND version=?` y rechazar conflictos.
4. Conectar la interfaz a la API (botón de Google, estado de sesión) manteniendo el modo local.
5. Importar los datos locales de forma transaccional e idempotente tras vincular `him` con azul y `her` con rosa. No importar el modo de ejemplo.
6. Despliegue en Vercel: adaptar `server.mjs` a funciones y configurar las variables de entorno allí.

Pruebas: `tests/schema.test.mjs` (9) cubre reparto, totales, datos inválidos, referencias entre hogares, límite de miembros, metas y el migrador; `tests/auth.test.mjs` (5) cubre variables faltantes, lista de correos, redirección a Google, orígenes ajenos y el vínculo con `users`. Repetirlas contra Turso al conectarlo.
