// Cola de lo hecho sin señal: registros nuevos y cambios de la lista de compras se guardan en este teléfono
// y se envían en orden cuando vuelve la conexión. Cada registro lleva su id, así reenviarlo no lo duplica.
// Tipos: transaction (gasto o aporte nuevo), task-create, task-done y task-delete.
let key = null;
let queue = [];
const listeners = new Set();

function load() {
  try {
    return JSON.parse(localStorage.getItem(key) || '[]');
  } catch {
    return [];
  }
}

function save() {
  try {
    localStorage.setItem(key, JSON.stringify(queue));
  } catch {
    // Sin almacenamiento la cola dura mientras la app siga abierta.
  }
  listeners.forEach(listener => listener());
}

// Una cola por hogar, para que otra cuenta en el mismo teléfono no envíe lo ajeno.
export function init(householdId) {
  key = `juntos-outbox-${householdId}`;
  queue = load();
}

export const items = () => queue;
export const waiting = () => queue.filter(op => !op.error).length;
export const failed = () => queue.filter(op => op.error);
export const onChange = listener => listeners.add(listener);

// Una operación con el mismo id reemplaza a la anterior (por ejemplo, marcar y desmarcar el mismo pendiente).
export function add(op) {
  queue = queue.filter(existing => existing.id !== op.id).concat({...op, queuedAt: new Date().toISOString(), error: null});
  save();
}

export function remove(predicate) {
  queue = queue.filter(op => !predicate(op));
  save();
}

// Envía en orden. Sin señal (status 0) se detiene para reintentar luego; si el servidor lo rechaza, queda marcado.
let flushing = null;
export function flush(send) {
  flushing ??= (async () => {
    let sent = 0;
    try {
      for (const op of [...queue]) {
        if (op.error) continue;
        try {
          await send(op);
          queue = queue.filter(existing => existing !== op);
          sent++;
          save();
        } catch (error) {
          if (error.status === 0) break;
          op.error = error.message;
          save();
        }
      }
    } finally {
      flushing = null;
    }
    return sent;
  })();
  return flushing;
}

// Al cerrar sesión no deben quedar registros pendientes de nadie en el teléfono.
export function clearAll() {
  try {
    Object.keys(localStorage).filter(name => name.startsWith('juntos-outbox-')).forEach(name => localStorage.removeItem(name));
  } catch {
    // Nada que borrar.
  }
  queue = [];
}
