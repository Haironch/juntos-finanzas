// Sonido y animación al registrar dinero. Los sonidos se sintetizan con Web Audio: no hay archivos que descargar.
// iOS solo deja iniciar audio en respuesta a un toque, por eso unlockAudio() se llama antes de guardar.
const SOUND_KEY = 'juntos-sound';
const reduceMotion = matchMedia('(prefers-reduced-motion: reduce)');
let audio = null;

export function soundEnabled() {
  try {
    return localStorage.getItem(SOUND_KEY) !== 'off';
  } catch {
    return true;
  }
}

function setSound(on) {
  try {
    if (on) localStorage.removeItem(SOUND_KEY);
    else localStorage.setItem(SOUND_KEY, 'off');
  } catch {
    // Sin almacenamiento la preferencia dura hasta cerrar la app.
  }
}

export function unlockAudio() {
  if (!soundEnabled()) return;
  try {
    audio ??= new (window.AudioContext || window.webkitAudioContext)();
    if (audio.state === 'suspended') audio.resume();
  } catch {
    audio = null;
  }
}

function tone(frequency, start, duration, {type = 'sine', gain = 0.15, slideTo} = {}) {
  const oscillator = audio.createOscillator();
  const volume = audio.createGain();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(frequency, start);
  if (slideTo) oscillator.frequency.exponentialRampToValueAtTime(slideTo, start + duration);
  volume.gain.setValueAtTime(0.0001, start);
  volume.gain.exponentialRampToValueAtTime(gain, start + 0.008);
  volume.gain.exponentialRampToValueAtTime(0.0001, start + duration);
  oscillator.connect(volume).connect(audio.destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.05);
}

// "Cha-ching": golpe metálico corto y una campanita que sube, con armónicos brillantes de moneda.
function playIncome() {
  const t = audio.currentTime + 0.02;
  tone(2093, t, 0.09, {type: 'square', gain: 0.035});
  tone(2793, t, 0.12, {type: 'triangle', gain: 0.1});
  tone(1568, t + 0.1, 0.14, {type: 'triangle', gain: 0.12});
  tone(2637, t + 0.19, 0.5, {type: 'triangle', gain: 0.14});
  tone(5274, t + 0.19, 0.35, {type: 'sine', gain: 0.035});
  tone(3951, t + 0.24, 0.4, {type: 'sine', gain: 0.04});
}

// Gasto: dos notas suaves que bajan, sin sonar a error.
function playExpense() {
  const t = audio.currentTime + 0.02;
  tone(659, t, 0.16, {type: 'triangle', gain: 0.12, slideTo: 622});
  tone(440, t + 0.13, 0.36, {type: 'triangle', gain: 0.12, slideTo: 330});
  tone(220, t + 0.13, 0.3, {type: 'sine', gain: 0.05, slideTo: 165});
}

// Monto grande al centro con monedas que saltan (ingreso) o billetes que caen (gasto).
function burst(kind, text) {
  const element = document.createElement('div');
  element.className = `money-burst ${kind}`;
  element.setAttribute('aria-hidden', 'true');
  const income = kind === 'income';
  const particles = reduceMotion.matches ? '' : Array.from({length: income ? 12 : 7}, (_, i) => {
    const x = Math.round((Math.random() * 2 - 1) * 130);
    const y = Math.round(income ? -(70 + Math.random() * 130) : 60 + Math.random() * 110);
    return `<i style="--x:${x}px;--y:${y}px;--r:${Math.round(Math.random() * 540 - 270)}deg;--delay:${i * 28}ms">${income ? '🪙' : '💸'}</i>`;
  }).join('');
  element.innerHTML = `<span class="burst-amount">${text}</span>${particles}`;
  document.body.append(element);
  setTimeout(() => element.remove(), 1700);
}

// kind: 'income' (entra dinero) o 'expense' (sale dinero).
export function celebrate(kind, text) {
  if (audio && soundEnabled()) {
    try {
      (kind === 'income' ? playIncome : playExpense)();
    } catch {
      // El audio es un adorno: si falla, no interrumpe el registro.
    }
  }
  burst(kind, text);
}

// Casilla de los ajustes para activar o apagar los sonidos en este dispositivo.
export function bindSoundToggle(input) {
  input.checked = soundEnabled();
  input.onchange = () => {
    setSound(input.checked);
    if (input.checked) {
      unlockAudio();
      celebrate('income', '♪');
    }
  };
}
