# Base de datos de Juntos

Estado: primera migración creada y probada en SQLite local. Todavía NO se aplicó en Turso, NO existe una API pública y la interfaz sigue usando el guardado del navegador.

## Modelo

| Tabla | Propósito |
| --- | --- |
| users | Identidad externa: emisor y sujeto de un proveedor de acceso aún por elegir. Sin contraseñas. |
| households | Espacio privado, moneda GTQ y zona horaria. |
| household_members | Hasta dos miembros por hogar, posiciones azul/rosa y nombres visibles. Cada usuario pertenece a un hogar. |
| transactions | Ingresos y gastos, dueño, autor, categoría y fecha local. |
| monthly_goals | Una meta por hogar y mes. |
| schema_migrations | Registro de migraciones locales y sus checksums. |

Un hogar puede tener un solo miembro durante la configuración, pero requiere dos para registrar un gasto compartido. La identidad/color de los miembros no cambia: eso evitará alterar los repartos históricos. Los nombres sí se pueden editar.

`transaction_allocations` es una vista calculada: ingresos positivos, gastos negativos, compartidos por mitad y centavo impar para rosa. Un gasto de Q 100.01 genera -5000 y -5001 centavos. No se almacenan saldos acumulados ni se descuentan las metas. Se filtra cada mes por fechas locales, sin arrastre automático.

## Ejecutar localmente

Desde la raíz del proyecto, con Python 3:

```sh
python3 scripts/migrate-local.py
python3 -m unittest discover -s tests -p '*_test.py' -v
```

El aplicador crea `.data/juntos.db`, fuera de Git; no carga datos de ejemplo. Cada migración se aplica en una transacción, y repetir el comando conserva los datos. No editar migraciones que ya estén aplicadas: agregar una nueva.

## Integración pendiente

1. Identificar la base remota y su motor. Este esquema utiliza SQLite/libSQL; confirmar compatibilidad antes de aplicar en otro motor. Turso distingue actualmente entre Turso Database y libSQL, con clientes diferentes: https://docs.turso.tech/sdk/ts/reference.
2. Configurar `TURSO_DATABASE_URL` y `TURSO_AUTH_TOKEN` solo en el entorno del servidor. Nunca en `dist/`, Git ni el navegador. `.env.example` contiene exclusivamente campos vacíos.
3. Adaptar el aplicador remoto al cliente elegido, preservando transacción y registro de checksum. Activar y verificar `PRAGMA foreign_keys=ON` en cada conexión; probar la migración en una base de desarrollo antes de producción.
4. Elegir el proveedor de acceso y asociar las dos identidades verificadas. La API debe resolver `household_id` y `created_by` desde la sesión, nunca confiar en esos valores enviados por el navegador. Una FK valida pertenencia, NO reemplaza autorización ni evita lecturas de otro hogar.
5. Implementar consultas parametrizadas siempre acotadas al hogar autorizado. Crear/editar metas y movimientos incrementa `version` y actualiza `updated_at`; editar con `WHERE household_id=? AND id=? AND version=?` y rechazar conflictos, para no sobrescribir cambios simultáneos.
6. Importar los datos locales, si existen, de forma transaccional e idempotente tras vincular `him` con azul y `her` con rosa. No importar automáticamente el modo de ejemplo.

No se instalaron clientes remotos ni se expusieron endpoints sin autenticación. Las siete pruebas cubren reparto, edición/borrado y totales, datos inválidos, referencias entre hogares, límite de miembros, metas y reaplicación de migraciones. Deben repetirse contra el motor remoto al conectarlo.
