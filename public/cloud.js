// Versión compartida: sesión con Google, hogar y datos en la API.
// Si el servidor no tiene inicio de sesión configurado (/api/me responde 503), la app sigue en modo local.
const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));

export const COLORS = {blue: 'Azul', pink: 'Rosa', green: 'Verde', purple: 'Morado', orange: 'Naranja', teal: 'Turquesa'};
// Tonos por color: texto, cifra, texto suave, marca, fondo suave, degradado (2) y borde.
const TONES = ['ink', 'strong', 'muted', 'mark', 'soft', 'bg1', 'bg2', 'line'];
const PALETTE = {
  blue: ['#4974af', '#3e6dae', '#859ab3', '#7cabed', '#e6f0fd', '#f0f6ff', '#f7faff', '#dde9f8'],
  pink: ['#ab6581', '#b66989', '#b093a0', '#e89dbb', '#f9e8f0', '#fcf1f6', '#fff9fc', '#f1e1e9'],
  green: ['#3f7d5f', '#357255', '#86a394', '#7fc0a0', '#e3f3ea', '#eef8f2', '#f7fcf9', '#d8ece1'],
  purple: ['#7156a8', '#654b9c', '#9d92b5', '#aa92e0', '#eee8fa', '#f4f0fd', '#faf8ff', '#e4dcf4'],
  orange: ['#b06a2c', '#a55f22', '#b89a80', '#f0a868', '#fbeee1', '#fdf4ea', '#fffaf5', '#f3e3d2'],
  teal: ['#2f7f86', '#26727a', '#84a6a9', '#6cc3c9', '#e0f3f4', '#ecf8f9', '#f6fcfc', '#d3ecee'],
};
// La app local llama him/her a las posiciones blue/pink del hogar.
const PERSON = {blue: 'him', pink: 'her'};
const SLOT = {him: 'blue', her: 'pink'};

let me = null;
let household = null;

async function request(method, path, body) {
  let response;
  try {
    response = await fetch(path, {
      method,
      credentials: 'same-origin',
      headers: body === undefined ? {} : {'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw Object.assign(new Error('Sin conexión. Revisa tu internet e inténtalo de nuevo.'), {status: 0});
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw Object.assign(new Error(data.error || 'No se pudo completar la operación.'), {status: response.status, data});
  return data;
}

const member = slot => household?.members.find(m => m.slot === slot);
const mine = () => household.members.find(m => m.isMe);

export const names = () => ({him: member('blue')?.displayName || 'Tu pareja', her: member('pink')?.displayName || 'Tu pareja'});
export const myPerson = () => PERSON[mine().slot];
export const hasPartner = () => household.members.length === 2;

// Devuelve la sesión cuando hay hogar; null para seguir en modo local. Sin sesión muestra la entrada y no resuelve.
export async function start() {
  let response;
  try {
    response = await fetch('/api/me', {credentials: 'same-origin'});
  } catch {
    return showGate(`<h1>Sin conexión</h1><p>No pudimos llegar al servidor de Juntos.</p><button class="button primary full" onclick="location.reload()">Reintentar</button>`, true);
  }
  if (response.status === 503 || response.status === 404) return null;
  if (response.status === 401) return showLogin();
  if (!response.ok) return showGate(`<h1>Algo salió mal</h1><p>El servidor no respondió como esperábamos.</p><button class="button primary full" onclick="location.reload()">Reintentar</button>`, true);
  ({user: me, household} = await response.json());
  if (!household) household = await onboarding();
  hideGate();
  refreshChrome();
  return {me, household};
}

function showGate(html, pending = false) {
  const gate = $('#gate');
  gate.innerHTML = `<div class="gate-card"><span class="brand gate-brand"><span class="brand-icon">j<span>j</span></span>juntos<span class="brand-dot">.</span></span>${html}</div>`;
  gate.hidden = false;
  document.body.classList.add('gated');
  return pending ? new Promise(() => {}) : undefined;
}

function hideGate() {
  $('#gate').hidden = true;
  document.body.classList.remove('gated');
}

function showLogin() {
  const params = new URLSearchParams(location.search);
  const denied = params.has('acceso') || params.has('error');
  if (denied) history.replaceState(null, '', location.pathname);
  showGate(`
    <p class="eyebrow">FINANZAS EN EQUIPO</p>
    <h1>Sus finanzas, en equipo.</h1>
    <p>Entren con su cuenta de Google y vean lo mismo desde sus dos teléfonos: ingresos, gastos compartidos y su meta del mes.</p>
    <button class="button primary full" id="google-login"><span class="google-g">G</span> Entrar con Google</button>
    <p class="form-error" role="alert">${denied ? 'No se pudo entrar con esa cuenta. Solo pueden entrar los correos autorizados para este hogar.' : ''}</p>
    <p class="gate-note">Juntos es privado: solo los correos autorizados pueden crear una cuenta.</p>`);
  $('#google-login').onclick = async event => {
    const button = event.currentTarget;
    button.disabled = true;
    try {
      const {url} = await request('POST', '/api/auth/sign-in/social', {provider: 'google', callbackURL: '/', errorCallbackURL: '/?acceso=denegado'});
      location.href = url;
    } catch (error) {
      $('#gate .form-error').textContent = error.message;
      button.disabled = false;
    }
  };
  return new Promise(() => {});
}

// Crear el hogar o unirse con el código de la pareja. Resuelve con el hogar.
function onboarding() {
  const first = (me.name || '').split(' ')[0].slice(0, 24);
  showGate(`
    <p class="eyebrow">BIENVENIDO, ${esc(first.toUpperCase() || 'A JUNTOS')}</p>
    <h1>Armemos su espacio.</h1>
    <p>Quien empieza crea el hogar y comparte un código; la otra persona se une con ese código.</p>
    <div class="gate-options">
      <form id="create-home" class="gate-option">
        <h2>Crear nuestro hogar</h2>
        <label class="field">Nombre del hogar<input name="name" maxlength="60" value="Nuestro hogar" required></label>
        <label class="field">Tu nombre<input name="displayName" maxlength="24" value="${esc(first)}" required></label>
        <p class="form-error" role="alert"></p>
        <button class="button primary full">Crear hogar</button>
      </form>
      <form id="join-home" class="gate-option">
        <h2>Tengo un código</h2>
        <label class="field">Código de tu pareja<input name="code" maxlength="20" placeholder="XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" required></label>
        <label class="field">Tu nombre<input name="displayName" maxlength="24" value="${esc(first)}" required></label>
        <p class="form-error" role="alert"></p>
        <button class="button secondary full">Unirme</button>
      </form>
    </div>
    <button class="text-button gate-logout" id="gate-logout">Salir de ${esc(me.email)}</button>`);
  $('#gate-logout').onclick = signOut;
  return new Promise(resolve => {
    const submit = (selector, path) => {
      $(selector).onsubmit = async event => {
        event.preventDefault();
        const form = event.currentTarget;
        const button = form.querySelector('button');
        button.disabled = true;
        try {
          resolve(await request('POST', path, Object.fromEntries(new FormData(form))));
        } catch (error) {
          form.querySelector('.form-error').textContent = error.message;
          button.disabled = false;
        }
      };
    };
    submit('#create-home', '/api/household');
    submit('#join-home', '/api/household/join');
  });
}

async function signOut() {
  try {
    await request('POST', '/api/auth/sign-out', {});
  } finally {
    location.href = '/';
  }
}

// Colores de cada persona como variables CSS (p1 = posición blue, p2 = posición pink).
function applyColors() {
  const root = document.documentElement.style;
  for (const [slot, prefix, fallback] of [['blue', 'p1', 'blue'], ['pink', 'p2', 'pink']]) {
    const tones = PALETTE[member(slot)?.color || fallback];
    TONES.forEach((tone, i) => root.setProperty(`--${prefix}-${tone}`, tones[i]));
  }
}

// Textos, iniciales y avisos que dependen del hogar.
function refreshChrome() {
  applyColors();
  const {him, her} = names();
  const initials = `${esc(him[0] || '·')}<span>${esc(hasPartner() ? her[0] : '+')}</span>`;
  $('#profile').innerHTML = initials;
  $('#profile').setAttribute('aria-label', 'Nuestro espacio y cuenta');
  $('.couple').innerHTML = initials;
  $('.workspace div').innerHTML = `${esc(household.name)}<small>${hasPartner() ? 'Un equipo de dos' : 'Esperando a tu pareja'}</small>`;
  $('.local-label').textContent = '◉ Sincronizado entre sus dispositivos';
  $('.local-pill').textContent = 'En la nube';
  $('#invite-banner').hidden = hasPartner();
}

const toLocalTransaction = t => ({
  id: t.id,
  kind: t.kind,
  scope: t.scope,
  amount: t.amountCents,
  description: t.description,
  date: t.occurredOn,
  category: t.category,
  // En un gasto compartido, person es quién pagó.
  person: PERSON[t.scope === 'personal' ? t.owner : t.paidBy],
  ...(t.scope === 'shared' && {settled: t.settled, pendingCents: t.pendingCents}),
  version: t.version,
});

const toLocalPending = pending => ({
  items: pending.items.map(toLocalTransaction),
  balance: pending.balance && {from: PERSON[pending.balance.from], to: PERSON[pending.balance.to], cents: pending.balance.cents},
});

export async function loadMonth(month) {
  const data = await request('GET', `/api/months/${month}`);
  return {
    transactions: data.transactions.map(toLocalTransaction),
    goal: data.goal && {name: data.goal.name, amount: data.goal.amountCents, version: data.goal.version},
    pending: toLocalPending(data.pending),
  };
}

// Marca como transferidos los gastos indicados (con la versión que se vio en pantalla).
export const settle = items => request('POST', '/api/pending/settle', {items: items.map(({id, version}) => ({id, version}))});

export function saveTransaction(t, existing) {
  const body = {
    kind: t.kind,
    scope: t.scope,
    amountCents: t.amount,
    description: t.description,
    occurredOn: t.date,
    category: t.kind === 'income' ? existing?.category || 'Otros' : t.category,
    ...(t.scope === 'personal' && {owner: SLOT[t.person]}),
    ...(t.scope === 'shared' && {paidBy: SLOT[t.person], settled: t.settled === true}),
  };
  if (!existing) return request('POST', '/api/transactions', body);
  return request('PATCH', `/api/transactions/${encodeURIComponent(existing.id)}`, {...body, version: existing.version});
}

export const deleteTransaction = t => request('DELETE', `/api/transactions/${encodeURIComponent(t.id)}`, {version: t.version});

export const saveGoal = (month, goal, existing) =>
  request('PUT', `/api/months/${month}/goal`, {name: goal.name, amountCents: goal.amount, ...(existing && {version: existing.version})});

// Ajustes de la cuenta: nombre, color, invitación y cierre de sesión.
export function openSettings(onChange) {
  const dialog = $('#cloud-settings-dialog');
  const self = mine();
  const partner = household.members.find(m => !m.isMe);
  const swatch = ([color, label]) => {
    const taken = partner?.color === color;
    return `<label class="swatch" title="${taken ? `${label}: lo usa ${esc(partner.displayName)}` : label}">
      <input type="radio" name="color" value="${color}" ${self.color === color ? 'checked' : ''} ${taken ? 'disabled' : ''}>
      <span style="--swatch:${PALETTE[color][3]}"></span><small>${label}</small></label>`;
  };
  dialog.innerHTML = `
    <form id="profile-form" method="dialog">
      <div class="modal-heading"><div><p class="eyebrow">${esc(household.name.toUpperCase())}</p><h2>Nuestro espacio</h2></div><button type="button" class="close" data-close aria-label="Cerrar">×</button></div>
      <label class="field">Tu nombre<input name="displayName" maxlength="24" value="${esc(self.displayName)}" required></label>
      <fieldset class="swatches"><legend>Tu color</legend>${Object.entries(COLORS).map(swatch).join('')}</fieldset>
      <p class="modal-intro">Cada quien tiene un color distinto para ver de un vistazo quién gastó qué. Cambiarlo no altera sus saldos.</p>
      <p class="form-error" role="alert"></p>
      <button class="button primary full">Guardar</button>
    </form>
    <section class="settings-section">
      <h3>Su hogar</h3>
      <ul class="member-list">${household.members.map(m => `<li><i class="dot" style="background:${PALETTE[m.color][3]}"></i>${esc(m.displayName)}${m.isMe ? ' <small>(tú)</small>' : ''}</li>`).join('')}</ul>
      ${partner ? '' : `<div id="invite-box"><p class="modal-intro">Tu pareja todavía no se une. Genera un código y compártelo; sirve una sola vez durante 7 días.</p><button class="button secondary full" id="create-invite">Generar código para mi pareja</button></div>`}
    </section>
    <section class="settings-section">
      <p class="modal-intro">Conectado como <b>${esc(me.email)}</b>. Moneda: quetzales (GTQ). Cada mes tiene ingresos, gastos y meta independientes.</p>
      <button class="button secondary full" id="sign-out">Cerrar sesión</button>
    </section>`;
  dialog.querySelector('[data-close]').onclick = () => dialog.close();
  $('#sign-out').onclick = signOut;
  $('#profile-form').onsubmit = async event => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(event.currentTarget));
    try {
      household = await request('PATCH', '/api/household/me', {displayName: data.displayName, color: data.color});
      refreshChrome();
      onChange();
      dialog.close();
    } catch (error) {
      event.currentTarget.querySelector('.form-error').textContent = error.message;
    }
  };
  const invite = $('#create-invite');
  if (invite) invite.onclick = async () => {
    invite.disabled = true;
    try {
      const {code, expiresAt} = await request('POST', '/api/household/invite', {});
      const until = new Date(expiresAt).toLocaleDateString('es-GT', {day: 'numeric', month: 'long'});
      $('#invite-box').innerHTML = `<p class="modal-intro">Comparte este código con tu pareja. Debe entrar con Google en esta misma página y elegir «Tengo un código». Vence el ${until}.</p>
        <div class="invite-code">${esc(code)}</div><button class="button secondary full" id="copy-invite">Copiar código</button>`;
      $('#copy-invite').onclick = async () => {
        await navigator.clipboard?.writeText(code).catch(() => {});
        $('#copy-invite').textContent = 'Código copiado ✓';
      };
    } catch (error) {
      invite.disabled = false;
      $('#invite-box .modal-intro').textContent = error.message;
    }
  };
  dialog.showModal();
}

// Vuelve a leer el hogar (por ejemplo, para saber si la pareja ya se unió).
export async function refreshHousehold() {
  ({household} = await request('GET', '/api/me'));
  refreshChrome();
}
