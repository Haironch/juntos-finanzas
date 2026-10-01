// Detalles para que Juntos se sienta como una app en el teléfono.
export const standalone = matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

// Abre al instante y permite ver lo último cargado sin conexión (ver sw.js).
export function registerServiceWorker() {
  if ('serviceWorker' in navigator && isSecureContext) navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Deslizar hacia abajo para actualizar. Solo en la app instalada: en Safari ya existe el gesto del navegador.
export function pullToRefresh(onRefresh) {
  if (!standalone) return;
  const indicator = document.createElement('div');
  indicator.className = 'ptr';
  indicator.setAttribute('aria-hidden', 'true');
  indicator.innerHTML = '<span>↓</span>';
  document.body.append(indicator);
  let startY = null, busy = false;
  const reset = () => {
    indicator.classList.remove('ready', 'loading');
    indicator.style.transform = '';
    indicator.style.opacity = '';
  };
  addEventListener('touchstart', event => {
    startY = !busy && scrollY <= 0 && event.touches.length === 1 && !document.querySelector('dialog[open]') ? event.touches[0].clientY : null;
  }, {passive: true});
  addEventListener('touchmove', event => {
    if (startY === null) return;
    if (scrollY > 0) {
      startY = null;
      return reset();
    }
    const pull = Math.min(Math.max(0, event.touches[0].clientY - startY) * 0.45, 80);
    indicator.style.transform = `translate(-50%, ${pull}px) rotate(${pull * 2.5}deg)`;
    indicator.style.opacity = Math.min(1, pull / 45);
    indicator.classList.toggle('ready', pull >= 56);
  }, {passive: true});
  addEventListener('touchend', async () => {
    if (startY === null) return;
    startY = null;
    if (!indicator.classList.contains('ready')) return reset();
    busy = true;
    indicator.classList.add('loading');
    indicator.style.transform = 'translate(-50%, 56px)';
    try {
      await onRefresh();
    } finally {
      busy = false;
      reset();
    }
  });
}

// Cerrar una hoja deslizándola hacia abajo desde su encabezado, como en iOS.
export function swipeToClose() {
  let dialog = null, startY = 0, startTime = 0, distance = 0;
  document.addEventListener('touchstart', event => {
    const heading = event.target.closest('dialog[open] .modal-heading');
    if (!heading || event.target.closest('button') || innerWidth > 720) return;
    const candidate = heading.closest('dialog');
    if (candidate.scrollTop > 0) return;
    dialog = candidate;
    startY = event.touches[0].clientY;
    startTime = Date.now();
    distance = 0;
    dialog.style.transition = 'none';
  }, {passive: true});
  document.addEventListener('touchmove', event => {
    if (!dialog) return;
    distance = Math.max(0, event.touches[0].clientY - startY);
    dialog.style.transform = `translateY(${distance}px)`;
  }, {passive: true});
  document.addEventListener('touchend', () => {
    if (!dialog) return;
    const sheet = dialog;
    dialog = null;
    const close = distance > 120 || (distance > 40 && distance / (Date.now() - startTime) > 0.6);
    sheet.style.transition = 'transform .2s ease-out';
    sheet.style.transform = close ? 'translateY(100%)' : '';
    setTimeout(() => {
      if (close) sheet.close();
      sheet.style.transform = '';
      sheet.style.transition = '';
    }, 200);
  });
}

// Tema claro u oscuro. "auto" sigue al teléfono; la elección se guarda solo en este dispositivo.
// El <head> de index.html aplica el tema antes de dibujar para evitar un destello blanco.
const THEME_KEY = 'juntos-theme';
const THEMES = {auto: 'Automático', light: 'Claro', dark: 'Oscuro'};
const darkQuery = matchMedia('(prefers-color-scheme: dark)');

export function themePreference() {
  try {
    return localStorage.getItem(THEME_KEY) || 'auto';
  } catch {
    return 'auto';
  }
}

export function applyTheme() {
  const preference = themePreference();
  const dark = preference === 'dark' || (preference === 'auto' && darkQuery.matches);
  document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  document.querySelector('meta[name=theme-color]')?.setAttribute('content', dark ? '#131e25' : '#ffffff');
  dispatchEvent(new Event('themechange'));
}

darkQuery.addEventListener('change', () => {
  if (themePreference() === 'auto') applyTheme();
});

function setThemePreference(value) {
  try {
    if (value === 'auto') localStorage.removeItem(THEME_KEY);
    else localStorage.setItem(THEME_KEY, value);
  } catch {
    // Sin almacenamiento disponible el tema dura hasta cerrar la app.
  }
  applyTheme();
}

// Selector Automático / Claro / Oscuro dentro de los ajustes.
export function bindThemeChoice(container) {
  const current = themePreference();
  container.innerHTML = Object.entries(THEMES).map(([value, label]) =>
    `<label><input type="radio" name="theme" value="${value}" ${value === current ? 'checked' : ''}><span>${label}</span></label>`).join('');
  container.onchange = event => setThemePreference(event.target.value);
}
