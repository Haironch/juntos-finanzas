# Base de datos de Juntos

Estado: migraciones 001 (datos), 002 (sesiones) y 003 (colores e invitaciones) probadas con el cliente libSQL (`@libsql/client`) sobre un archivo local. Inicio de sesión con Google (Better Auth) y `GET /api/me` listos en el servidor. API de hogar, movimientos, metas y resumen mensual lista. Aplicado en Turso (producción) y conectado a la interfaz mediante `public/cloud.js`.

## Modelo

| Tabla | Propósito |
| --- | --- |
| users | Identidad de Juntos: emisor `better-auth` y sujeto = id de `auth_users`. Se crea al consultar `/api/me`. Sin contraseñas. |
| households | Espacio privado, moneda GTQ y zona horaria. |
| household_members | Hasta dos miembros por hogar. `slot` es la posición permanente (blue = quien creó el hogar, pink = quien se unió) y decide el centavo impar. `color` es visual, editable y distinto entre los dos. Cada usuario pertenece a un hogar. |
| household_invites | Códigos de un solo uso (solo su hash), válidos 7 días; uno nuevo invalida los anteriores. |
| transactions | Ingresos y gastos, dueño, autor, categoría y fecha local. |
| monthly_goals | Una meta por hogar y mes. |
| auth_users, auth_sessions, auth_accounts, auth_verifications | Tablas de Better Auth (columnas camelCase). Tokens OAuth cifrados. |
| schema_migrations | Registro de migraciones y sus checksums. |

Un hogar puede tener un solo miembro durante la configuración, pero requiere dos para registrar un gasto compartido. La posición (`slot`) de los miembros no cambia: eso evita alterar los repartos históricos. El nombre y el color sí se pueden editar; los colores disponibles son blue, pink, green, purple, orange y teal.

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

## API del hogar

Todas requieren sesión. Las que modifican datos exigen `Origin` igual a `BETTER_AUTH_URL` y cuerpo JSON (máx. 10 KB). El usuario y el hogar salen siempre de la sesión.

| Ruta | Qué hace |
| --- | --- |
| `GET /api/me` | `{user, household}`; `household` es `null` sin hogar. |
| `POST /api/household` `{name, displayName}` | Crea el hogar; quien lo crea queda en blue con color azul. |
| `POST /api/household/invite` `{}` | Devuelve `{code: "XXXX-XXXX-XXXX", expiresAt}` para compartir con la pareja. |
| `POST /api/household/join` `{code, displayName}` | Une a la pareja en pink con el primer color libre (rosa). Acepta el código sin guiones o en minúsculas. |
| `PATCH /api/household/me` `{displayName?, color?}` | Cada quien edita su nombre o color; 409 si el color ya lo usa su pareja. |

Para intercambiar colores, una persona elige primero un tercer color.

## API de movimientos y metas

Montos siempre en centavos enteros (`amountCents`); fechas `AAAA-MM-DD`; las personas se identifican por su posición `blue`/`pink`. Ambos miembros pueden editar cualquier movimiento del hogar; `createdBy` conserva quién lo registró.

| Ruta | Qué hace |
| --- | --- |
| `GET /api/months/:month` | `{month, transactions, goal, summary}` del mes (`2026-09`). `summary` trae `income`, `expense` y `balance` por posición y los totales, con los mismos cálculos que `public/finance.js`. Sin arrastre entre meses. |
| `POST /api/transactions` `{kind, scope, amountCents, description, occurredOn, category, owner?}` | `owner` (`blue`/`pink`) solo en personales. Los ingresos son siempre personales; sin categoría quedan en `Otros`. Un gasto compartido requiere que la pareja se haya unido. |
| `PATCH /api/transactions/:id` `{version, ...campos}` | Edición parcial; se valida el resultado completo. Pasar a `shared` limpia `owner`. |
| `DELETE /api/transactions/:id` `{version}` | Elimina el movimiento. |
| `PUT /api/months/:month/goal` `{name, amountCents, version?}` | Sin `version` crea la meta; con la `version` actual la reemplaza. |
| `DELETE /api/months/:month/goal` `{version}` | Elimina la meta del mes. |

### Mes al que cuenta un movimiento

Cada movimiento tiene su fecha (`occurredOn`) y el mes al que cuenta (`budgetMonth`): el de la fecha o el siguiente, por ejemplo el sueldo del 30 de septiembre para octubre. Por defecto es el mes de la fecha. `GET /api/months/:month` y los saldos filtran por `budgetMonth`. Al editar la fecha sin indicar `budgetMonth`, se conserva si sigue siendo válido y si no pasa al mes de la nueva fecha. La migración 005 dejó los movimientos existentes en el mes de su fecha.

### Gastos pagados por una persona

Un gasto compartido guarda quién pagó (`paidBy`, por defecto quien lo registra) y si la otra persona ya transfirió su mitad (`settled`, por defecto `false`). Mientras está pendiente, quien pagó carga el gasto completo y la otra persona le debe su parte (`pendingCents`, con el centavo impar para pink). Al saldarlo se divide mitad y mitad **en el mes al que cuenta el gasto**. Los compartidos anteriores a la migración 004 quedaron saldados, sin cambiar saldos.

| Ruta | Qué hace |
| --- | --- |
| `GET /api/pending` | `{items, owes, balance}`: gastos pendientes de cualquier mes, cuánto debe cada posición y el neto (`{from, to, cents}` o `null` si están a mano). También viene en `GET /api/months/:month` como `pending`. |
| `POST /api/pending/settle` `{items: [{id, version}]}` | Marca como transferidos esos gastos. Si alguno cambió desde que se leyó, responde 409 y no marca ninguno. |

`POST`/`PATCH /api/transactions` aceptan `paidBy` y `settled` en gastos compartidos; `settled: false` en un `PATCH` vuelve a dejarlo pendiente.

### Préstamos

Un préstamo es un gasto personal que pagó la otra persona: `scope: "personal"`, `owner` (de quién es el gasto) y `paidBy` distinto del dueño. Mientras no se devuelve (`settled: false`, por defecto) se descuenta a quien pagó y el dueño le debe el monto completo (`pendingCents`). Al marcarlo como devuelto pasa al saldo del dueño. Aparece en `pending` junto a los compartidos y se compensa en el neto; se salda con el mismo `POST /api/pending/settle`. `loan: true` lo identifica. Con `paidBy` igual al dueño (o sin `paidBy`) es un gasto personal normal; los ingresos nunca son préstamos.

### Lista de pendientes (por comprar y por pagar)

Tabla `household_tasks` (migración 007): `kind` `buy` o `pay`, `title`, `amountCents` y `dueOn` opcionales, quién la agregó y quién/cuándo la marcó como hecha. Cuenta en la huella del hogar para verse en vivo.

| Ruta | Qué hace |
| --- | --- |
| `GET /api/tasks` | `{items}`: abiertos primero (pagos por fecha límite), completados al final. |
| `POST /api/tasks` `{kind, title, amountCents?, dueOn?}` | Agrega a la lista. |
| `PATCH /api/tasks/:id` `{version, title?, amountCents?, dueOn?, done?}` | Edita o marca/desmarca como hecho. |
| `DELETE /api/tasks/:id` `{version}` | Borra un pendiente. |
| `DELETE /api/tasks/done` | Borra todos los completados. |

### Notificaciones push

Tabla `push_subscriptions` (migración 008): un registro por teléfono. Al crear un movimiento o saldar pendientes se avisa solo a la pareja (nunca al autor), esperando como máximo 4 segundos para no demorar el registro; si el servicio responde 404/410 se borra la suscripción. Solo se aceptan servicios de push conocidos (Apple, Google, Mozilla, Microsoft).

| Ruta | Qué hace |
| --- | --- |
| `GET /api/push/key` | Clave pública VAPID; 503 si no están configuradas. |
| `POST /api/push/subscribe` `{endpoint, keys: {p256dh, auth}}` | Registra este teléfono para el usuario de la sesión. |
| `DELETE /api/push/subscribe` `{endpoint}` | Deja de avisar a este teléfono. |

### Registros hechos sin señal

`POST /api/transactions` y `POST /api/tasks` aceptan un `id` (UUID) creado en el teléfono. Si ya existe en el mismo hogar se devuelve el guardado (`replayed: true` en movimientos) sin duplicarlo ni volver a notificar; si pertenece a otro hogar, 409. Desde la cola, `PATCH /api/tasks/:id` con solo `{done}` y `DELETE /api/tasks/:id` sin `version` se aceptan (gana el último).

Ediciones simultáneas: toda edición o borrado exige la `version` que se leyó. Si la pareja cambió el dato antes, la API responde 409 con `current` (el dato vigente) para mostrarlo y decidir, en lugar de sobrescribirlo. Movimientos de otro hogar responden 404.

## Interfaz

`public/cloud.js` consulta `/api/me` al abrir la app: 503 → versión local (localStorage); 401 → pantalla de entrada con Google; sin hogar → crear hogar o unirse con código; con hogar → modo compartido. En ese modo `app.js` guarda cada operación en la API, recarga el mes desde el servidor y, ante un 409, muestra la versión de la pareja en el formulario. Los colores de cada persona se aplican como variables CSS (`--p1-*` para blue, `--p2-*` para pink).

## Pendiente

1. Importar los datos de la versión local (localStorage) de forma transaccional e idempotente, si existen. No importar el modo de ejemplo.
2. Mostrar los cambios de la pareja sin recargar (hoy se actualiza al volver a la pestaña o al cambiar de mes).

Pruebas: `tests/schema.test.mjs` (9) cubre reparto, totales, datos inválidos, referencias entre hogares, límite de miembros, metas y el migrador; `tests/auth.test.mjs` (5) cubre variables faltantes, lista de correos, redirección a Google, orígenes ajenos y el vínculo con `users`; `tests/households.test.mjs` (8) recorre la API por HTTP: crear, invitar, unirse, códigos usados/vencidos/reemplazados, segundo hogar, colores distintos, reparto intacto al cambiar colores y rechazo de otros orígenes; `tests/finances.test.mjs` (10) cubre el resumen frente al motor local, autoría, validaciones, hogar incompleto, versiones y conflictos, borrado, aislamiento entre hogares, metas y escrituras simultáneas. Repetirlas contra Turso al conectarlo.
