// Notificaciones push en este teléfono: avisan cuando la pareja registra o salda algo, aunque la app esté cerrada.
// En iPhone solo funcionan con Juntos instalada en la pantalla de inicio (iOS 16.4 o posterior).
import * as cloud from './cloud.js';
import {standalone} from './native.js';

const isIOS = /iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
const ASKED_KEY = 'juntos-push-asked';
let publicKey = null;

const supported = () => 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;

async function key() {
  if (publicKey === null) {
    try {
      publicKey = (await cloud.pushKey()).publicKey;
    } catch {
      publicKey = false;
    }
  }
  return publicKey;
}

function toBytes(base64url) {
  const padded = base64url + '='.repeat((4 - base64url.length % 4) % 4);
  return Uint8Array.from(atob(padded.replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0));
}

const withTimeout = (promise, ms, message) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(message)), ms))]);

async function currentSubscription() {
  const registration = await navigator.serviceWorker.getRegistration();
  return registration?.pushManager.getSubscription() ?? null;
}

// unavailable (servidor sin claves) · install (iPhone sin instalar) · unsupported · denied · off · on
async function state() {
  if (!await key()) return 'unavailable';
  if (!supported()) return isIOS && !standalone ? 'install' : 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  return Notification.permission === 'granted' && await currentSubscription() ? 'on' : 'off';
}

// Debe llamarse desde un toque: el permiso es lo primero que se pide (iOS exige el gesto del usuario).
async function enable() {
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') {
    throw new Error(permission === 'denied' ? 'Las bloqueaste. Para activarlas ve a Ajustes → Notificaciones → Juntos.' : 'No se activaron las notificaciones.');
  }
  const registration = await withTimeout(navigator.serviceWorker.ready, 10000, 'La app todavía no está lista; ciérrala y ábrela de nuevo.');
  const subscription = await registration.pushManager.getSubscription()
    ?? await registration.pushManager.subscribe({userVisibleOnly: true, applicationServerKey: toBytes(await key())});
  await cloud.subscribePush(subscription.toJSON());
}

async function disable() {
  const subscription = await currentSubscription();
  if (!subscription) return;
  await cloud.unsubscribePush(subscription.endpoint).catch(() => {});
  await subscription.unsubscribe();
}

// Si el teléfono ya tenía permiso, vuelve a registrar la suscripción por si cambió (o cambió la cuenta).
export async function sync() {
  try {
    if (supported() && Notification.permission === 'granted' && await key()) {
      const subscription = await currentSubscription();
      if (subscription) await cloud.subscribePush(subscription.toJSON());
    }
  } catch {
    // Se reintentará la próxima vez que se abra la app.
  }
}

// Sección de Nuestro espacio con el estado y el botón para activar o desactivar.
export async function bindPushSection(section, partnerName) {
  const render = async (error = '') => {
    const current = await state();
    section.hidden = current === 'unavailable';
    const texts = {
      install: 'En iPhone las notificaciones funcionan con Juntos instalada: en Safari toca Compartir → Agregar a pantalla de inicio, y ábrela desde el ícono.',
      unsupported: 'Este navegador no permite notificaciones.',
      denied: 'Están bloqueadas en este teléfono. Actívalas en Ajustes → Notificaciones → Juntos.',
      off: `Te avisamos cuando ${partnerName} registre un gasto o un aporte, o salde un pendiente, aunque tengas la app cerrada.`,
      on: '✓ Activadas en este teléfono.',
    };
    section.innerHTML = `<h3>Notificaciones</h3><p class="modal-intro">${texts[current] || ''}</p>
      ${current === 'off' ? '<button class="button primary full" data-push="on">🔔 Activar notificaciones</button>' : ''}
      ${current === 'on' ? '<button class="button secondary full" data-push="off">Desactivar en este teléfono</button>' : ''}
      <p class="form-error" role="alert">${error}</p>`;
  };
  section.onclick = async event => {
    const button = event.target.closest('[data-push]');
    if (!button) return;
    button.disabled = true;
    try {
      if (button.dataset.push === 'on') await enable();
      else await disable();
      await render();
    } catch (error) {
      await render(error.message);
    }
  };
  await render();
}

// Invitación única a activarlas, solo en la app instalada y si todavía no se decidió.
export async function offer(partnerName) {
  try {
    if (!standalone || localStorage.getItem(ASKED_KEY) || await state() !== 'off') return;
  } catch {
    return;
  }
  const banner = document.querySelector('#push-banner');
  banner.querySelector('span').textContent = `🔔 ¿Te avisamos cuando ${partnerName} registre algo, aunque tengas la app cerrada?`;
  banner.hidden = false;
  const close = () => {
    banner.hidden = true;
    try {
      localStorage.setItem(ASKED_KEY, '1');
    } catch {
      // Sin almacenamiento se volverá a ofrecer.
    }
  };
  banner.querySelector('#push-later').onclick = close;
  banner.querySelector('#push-enable').onclick = async () => {
    try {
      await enable();
      close();
    } catch (error) {
      banner.querySelector('span').textContent = error.message;
    }
  };
}
