// "Pendientes": lista compartida de cosas por comprar y pagos por hacer, abierta desde la barra superior.
import * as cloud from './cloud.js';
import * as effects from './effects.js';

const $ = s => document.querySelector(s);
const esc = s => String(s).replace(/[&<>"']/g, c => ({'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]));
const money = cents => 'Q ' + (cents / 100).toLocaleString('es-GT', {minimumFractionDigits: 2, maximumFractionDigits: 2});
const KINDS = {
  buy: {label: 'Por comprar', icon: '🛒', placeholder: '¿Qué hace falta comprar?', empty: 'No falta nada por comprar. ✨'},
  pay: {label: 'Por pagar', icon: '💳', placeholder: '¿Qué hay que pagar? (tarjeta, luz…)', empty: 'No hay pagos pendientes. ✨'},
};

let items = [];
let tab = 'buy';
let showDone = false;
let openExpense = null;

function localToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

// Texto de la fecha límite; urgente si venció o vence en los próximos 3 días.
function due(date) {
  const days = Math.round((new Date(date + 'T12:00:00') - new Date(localToday() + 'T12:00:00')) / 86400000);
  if (days < 0) return {text: `venció hace ${-days} ${days === -1 ? 'día' : 'días'}`, urgent: true};
  if (days === 0) return {text: 'vence hoy', urgent: true};
  if (days === 1) return {text: 'vence mañana', urgent: true};
  if (days <= 3) return {text: `vence en ${days} días`, urgent: true};
  return {text: `vence el ${new Date(date + 'T12:00:00').toLocaleDateString('es-GT', {day: 'numeric', month: 'short'})}`, urgent: false};
}

const isUrgent = t => !t.done && t.dueOn && due(t.dueOn).urgent;

function updateBadge() {
  const open = items.filter(t => !t.done);
  const badge = $('#tasks-count');
  badge.hidden = !open.length;
  badge.textContent = open.length;
  badge.classList.toggle('urgent', open.some(isUrgent));
  $('#tasks-button').setAttribute('aria-label', `Pendientes: ${open.length} por hacer`);
}

function taskRow(task) {
  const names = cloud.names();
  const meta = [`<i class="dot ${task.createdBy === 'him' ? 'blue' : 'pink'}"></i>${esc(names[task.createdBy] || '')}`];
  if (task.amountCents) meta.push(money(task.amountCents));
  if (task.dueOn && !task.done) {
    const {text, urgent} = due(task.dueOn);
    meta.push(`<span class="${urgent ? 'task-urgent' : ''}">${text}</span>`);
  }
  if (task.done && task.doneBy) meta.push(`hecho por ${esc(names[task.doneBy] || '')}`);
  return `<li class="task${task.done ? ' done' : ''}" data-id="${esc(task.id)}">
    <button class="task-check" data-action="toggle" aria-label="${task.done ? 'Desmarcar' : 'Marcar como hecho'}: ${esc(task.title)}" aria-pressed="${task.done}"><span>✓</span></button>
    <div class="task-body"><strong>${esc(task.title)}</strong><small>${meta.join(' · ')}</small></div>
    ${task.done ? '' : `<button class="task-action" data-action="expense" title="Registrar como gasto">＋ gasto</button>`}
    <button class="task-action task-delete" data-action="delete" aria-label="Borrar: ${esc(task.title)}">×</button>
  </li>`;
}

function render() {
  const dialog = $('#tasks-dialog');
  const kind = KINDS[tab];
  const open = items.filter(t => !t.done && t.kind === tab);
  const done = items.filter(t => t.done && t.kind === tab);
  const count = k => items.filter(t => !t.done && t.kind === k).length;
  const draft = dialog.querySelector('#task-form input[name=title]')?.value || '';
  dialog.innerHTML = `
    <div class="modal-heading"><div><p class="eyebrow">LO QUE FALTA</p><h2>Pendientes</h2></div><button type="button" class="close" data-action="close" aria-label="Cerrar">×</button></div>
    <div class="filter-tabs task-tabs" role="group" aria-label="Tipo de pendiente">
      ${Object.entries(KINDS).map(([value, k]) => `<button data-tab="${value}" class="${value === tab ? 'selected' : ''}" aria-pressed="${value === tab}"><span aria-hidden="true">${k.icon}</span><span>${k.label}</span>${count(value) ? `<b>${count(value)}</b>` : ''}</button>`).join('')}
    </div>
    <form id="task-form" class="task-form">
      <div class="task-input"><input name="title" maxlength="100" placeholder="${kind.placeholder}" autocomplete="off" enterkeyhint="done" required value="${esc(draft)}"><button class="button primary" aria-label="Agregar">＋</button></div>
      ${tab === 'pay' ? `<div class="task-extra"><label>Monto <input name="amount" type="number" min="0.01" step="0.01" inputmode="decimal" placeholder="Opcional"></label><label>Vence <input name="dueOn" type="date"></label></div>` : ''}
    </form>
    <p class="form-error" role="alert"></p>
    ${open.length ? `<ul class="task-list">${open.map(taskRow).join('')}</ul>` : `<p class="task-empty">${kind.empty}</p>`}
    ${done.length ? `<div class="task-done-section"><div class="task-done-heading"><button class="text-button" data-action="toggle-done">${showDone ? '▾' : '▸'} Completados (${done.length})</button>${showDone ? '<button class="text-button" data-action="clear-done">Borrar completados</button>' : ''}</div>${showDone ? `<ul class="task-list">${done.map(taskRow).join('')}</ul>` : ''}</div>` : ''}`;
  dialog.querySelector('#task-form').onsubmit = add;
}

function showError(error) {
  const message = $('#tasks-dialog .form-error');
  if (message) message.textContent = error.message;
  if (error.status === 409 || error.status === 404) refresh();
}

async function add(event) {
  event.preventDefault();
  const form = event.currentTarget;
  const data = Object.fromEntries(new FormData(form));
  const body = {kind: tab, title: data.title};
  if (data.amount) body.amountCents = Math.round(Number(data.amount) * 100);
  if (data.dueOn) body.dueOn = data.dueOn;
  try {
    const task = await cloud.createTask(body);
    items.push(task);
    form.reset();
    await refresh();
    $('#tasks-dialog #task-form input[name=title]')?.focus();
  } catch (error) {
    showError(error);
  }
}

async function onClick(event) {
  const button = event.target.closest('button');
  if (!button) return;
  const dialog = $('#tasks-dialog');
  if (button.dataset.tab) {
    tab = button.dataset.tab;
    render();
    return;
  }
  const action = button.dataset.action;
  if (action === 'close') return dialog.close();
  if (action === 'toggle-done') {
    showDone = !showDone;
    return render();
  }
  if (action === 'clear-done') {
    if (!confirm('¿Borrar todos los pendientes completados?')) return;
    try {
      await cloud.clearDoneTasks();
      await refresh();
    } catch (error) {
      showError(error);
    }
    return;
  }
  const task = items.find(t => t.id === button.closest('[data-id]')?.dataset.id);
  if (!task) return;
  try {
    if (action === 'toggle') {
      effects.unlockAudio();
      if (!task.done) {
        button.closest('li').classList.add('checking');
        effects.tick();
      }
      // Deja ver la animación del check antes de redibujar.
      await Promise.all([cloud.updateTask(task, {done: !task.done}), new Promise(resolve => setTimeout(resolve, task.done ? 0 : 350))]);
      await refresh();
    } else if (action === 'delete') {
      await cloud.deleteTask(task);
      await refresh();
    } else if (action === 'expense') {
      dialog.close();
      openExpense(task);
    }
  } catch (error) {
    showError(error);
  }
}

function open() {
  render();
  $('#tasks-dialog').showModal();
}

// Vuelve a leer la lista. Devuelve lo nuevo que agregó la pareja, para avisarlo.
export async function refresh() {
  try {
    const known = new Set(items.map(t => t.id));
    const first = !items.length && !$('#tasks-button').dataset.loaded;
    items = await cloud.loadTasks();
    $('#tasks-button').dataset.loaded = '1';
    updateBadge();
    if ($('#tasks-dialog').open) render();
    const me = cloud.myPerson();
    return first ? [] : items.filter(t => !known.has(t.id) && t.createdBy !== me);
  } catch {
    return [];
  }
}

export const kindLabel = kind => KINDS[kind].label.toLowerCase();

// Solo en la versión compartida: muestra el botón de la barra superior y carga la lista.
export async function init(options) {
  openExpense = options.openExpense;
  $('#tasks-button').hidden = false;
  $('#tasks-button').onclick = open;
  $('#tasks-dialog').addEventListener('click', onClick);
  await refresh();
}
