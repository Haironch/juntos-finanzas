# Juntos · Finanzas en pareja

En producción en https://juntos-finanzas.vercel.app (Vercel + Turso). Cada persona entra con Google; quien crea el hogar comparte un código de un solo uso y la pareja se une con él. Los movimientos y metas se guardan en el servidor y ambos ven lo mismo, cada quien con su color. Detalles de datos y API en [database/README.md](database/README.md).

En local, la configuración va en `.env` (ver `.env.example`). Sin ella, `npm run dev` abre la versión local de siempre, que guarda en el navegador. El puerto se cambia con `PORT`.

Primera versión local en español y quetzales. Abrir http://127.0.0.1:5173 después de ejecutar `npm run dev` desde esta carpeta. Requiere Node.js 22; ejecutar `npm install` una vez (cliente libSQL para la base de datos). `npm test` verifica los cálculos y `npm run check` revisa la sintaxis.

## Funciona hoy

- Ingresos por persona, colores azul y rosa, y saldo conjunto.
- Gastos personales o compartidos 50/50, edición y eliminación con confirmación.
- Importes calculados como centavos enteros. Cuando el reparto tiene un centavo indivisible, el saldo rosa asume ese centavo.
- Meta mensual, margen antes de cada gasto, categorías, búsqueda y filtros.
- Meses independientes: no se trasladan automáticamente saldos. El saldo actual es ahorro potencial, no dinero reservado ni una transferencia bancaria.
- Nombres configurables. Ejemplo interactivo en memoria separado de los datos reales.
- Guardado en localStorage, respaldo JSON y restauración validada. La restauración reemplaza los datos actuales después de confirmar.
- Diseño adaptable a computadora y móvil; navegación con teclado y diálogos nativos.

Los datos se conservan solo en este navegador y origen (usar siempre la misma URL). No hay autenticación ni sincronización entre equipos. Borrar los datos del navegador elimina el guardado: descargar respaldos periódicamente. No publicar esta versión como una aplicación compartida de producción.

## Stack y siguiente etapa

La versión local usa HTML, CSS y módulos JavaScript, servidos con Node.js; el motor financiero está separado de la interfaz. Esto permite validar el flujo sin dependencias ni cuentas externas.

Para la versión compartida recomiendo Vercel + Turso: interfaz y API en Vercel, persistencia mediante el cliente libSQL de Turso en el servidor. Incorporar autenticación, un hogar privado con exactamente dos miembros, autorización de cada operación, migraciones, y validación de importes en la API. Nunca exponer el token de Turso en el navegador. React/Next.js sería una opción para estructurar esa siguiente etapa si crecen las pantallas; no está instalado en esta versión.

Render queda como alternativa para alojar una API persistente si surgen procesos en segundo plano. Esta primera versión no necesita ese servicio adicional. No se crearon servicios ni se desplegó nada.

Referencias: https://vercel.com/docs/frameworks y https://github.com/tursodatabase/libsql-client-ts

## Verificación

Seis pruebas de dinero, reparto, fechas, aislamiento mensual y saldos negativos. Comprobación manual en navegador del ejemplo, registro compartido, cambio mensual y edición de meta. Revisión visual en escritorio y móvil.

Se expone opcionalmente la consulta de solo lectura WebMCP `read_month_summary` si el navegador la admite; usa los mismos cálculos que la interfaz.

## En el teléfono

- Instalable desde Safari con "Agregar a pantalla de inicio" (`manifest.webmanifest`, íconos en `public/icons/`). Se abre como app, sin barra del navegador.
- Sin señal (`public/outbox.js`): los gastos y aportes nuevos y los cambios de la lista de compras se guardan en el teléfono con "por enviar" y se envían solos al volver la conexión (al abrir la app, al recuperar la señal y cada 8 segundos). Cada registro lleva un id creado en el teléfono, así un reenvío no se duplica ni repite la notificación. Con señal mala, a los 15 segundos se guarda para después. Editar o borrar movimientos ya enviados, saldar y cambiar la meta necesitan conexión. Un registro por enviar se puede cancelar; lo que el servidor rechace queda marcado para descartarlo desde la etiqueta de arriba.
- `public/sw.js` guarda la app y los últimos datos del hogar (incluido el mes anterior): abre al instante y, sin conexión, muestra lo último cargado. Siempre intenta la red primero. Al cerrar sesión se borran los datos guardados y la cola.
- Cambios de la pareja sin recargar: mientras la app está a la vista consulta `GET /api/sync` cada 8 segundos (y al volver a abrirla); si la huella del hogar cambió, recarga el mes y avisa lo que registró la otra persona.
- Gestos (`public/native.js`): deslizar hacia abajo para actualizar (solo en la app instalada), deslizar una hoja hacia abajo para cerrarla y botón flotante + para registrar un gasto.
- Sesiones de 60 días que se renuevan con el uso.
- Al registrar algo nuevo (o saldar un pendiente) suena un "cha-ching" de monedas si entra dinero o un tono grave si sale, y aparece el monto animado (`public/effects.js`, sonidos sintetizados con Web Audio, sin archivos). Los saldos cuentan hasta su nuevo valor y el movimiento nuevo se ilumina. Los sonidos se apagan en Nuestro espacio > Apariencia y respetan el modo silencio.
- Pendientes (botón de la barra superior, `public/tasks.js`): lista compartida de cosas por comprar y pagos por hacer, con monto y fecha límite opcionales. El número se pone rojo si un pago vence en 3 días o menos. "＋ gasto" abre el registro ya lleno y marca el pendiente como hecho al guardar.
- Notificaciones push (iOS 16.4+ con la app instalada): avisan a la pareja cuando alguien registra un gasto o aporte, o salda un pendiente. Se activan en Nuestro espacio > Notificaciones. Requieren `VAPID_PUBLIC_KEY` y `VAPID_PRIVATE_KEY` en Vercel (generarlas con `npx web-push generate-vapid-keys`); `VAPID_SUBJECT` es opcional. Sin ellas la app funciona igual, sin avisos.
- Modo oscuro: por defecto sigue al teléfono; en Nuestro espacio > Apariencia se elige Automático, Claro u Oscuro (se guarda en cada dispositivo). Un script en el `<head>` aplica el tema antes de dibujar. Los colores de cada persona tienen paleta clara y oscura en `public/cloud.js`.

## Publicar en Vercel

Vercel detecta `server.mjs` y lo convierte en una función; los archivos de `public/` se sirven desde su CDN. Node 22 (`engines` en `package.json`).

1. Crear la base de producción en Turso y aplicar las migraciones desde este equipo, con `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` de esa base en `.env`: `npm run db:migrate`.
2. En Vercel: Add New > Project > importar `Haironch/juntos-finanzas`, sin framework ni comando de build.
3. En Settings > Environment Variables (Production): `TURSO_DATABASE_URL`, `TURSO_AUTH_TOKEN`, `BETTER_AUTH_SECRET` (uno nuevo, distinto al local), `BETTER_AUTH_URL=https://<dominio>`, `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `ALLOWED_EMAILS`. Volver a desplegar después de cambiarlas.
4. En Google Auth Platform > Clientes, agregar el URI de redirección `https://<dominio>/api/auth/callback/google`.
5. Comprobar `https://<dominio>/api/auth/ok` → `{"ok":true}`.

Cada nueva migración se aplica con `npm run db:migrate` apuntando a la base de producción antes de desplegar el código que la usa.
