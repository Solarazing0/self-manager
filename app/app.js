const $ = (selector) => document.querySelector(selector);
const titles = { day: 'Сегодня', inbox: 'Входящие', work: 'Планы', memory: 'Память' };
const labels = {
  new: 'К обсуждению', deferred: 'Отложено', planned: 'План согласован', memory: 'В памяти',
  cancelled: 'Отменено', ready: 'Готово к началу', active: 'В процессе', done: 'Выполнено',
  missed: 'Не выполнено', partial: 'Частичный результат', confirmed: 'Подтверждено', archived: 'Архив', merged: 'Объединено',
  pending: 'Ожидает решения', accepted: 'Согласовано', rejected: 'Отклонено', superseded: 'Заменено',
  part_of: 'часть', blocked_by: 'зависит от', contributes_to: 'помогает цели',
  low: 'Низкий', normal: 'Обычный', high: 'Высокий',
};
const eventLabels = {
  proposed: 'Предложение', accepted: 'Согласовано', rejected: 'Отклонено', start: 'Начало',
  result: 'Результат', correct: 'Уточнение истории', linked: 'Связь добавлена', unlinked: 'Связь снята',
  merged: 'Работа объединена', unmerged: 'Объединение отменено',
};
let state;
let view = 'day';
let itemId = null;
let chosenDay = '';
let showArchive = false;
let saveForm;
let sending = false;
let requestDraft;
let previewDismissed;
let refreshVersion = 0;
const waiting = new Set();
const dialog = $('#editor');
const chat = $('#chat');
const content = $('#content');
const input = $('#chat-input');
const browserZone = Intl.DateTimeFormat().resolvedOptions().timeZone;

function el(tag, className, ...children) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.append(...children);
  return node;
}

function button(text, click, className) {
  const node = el('button', className, text);
  node.type = 'button';
  node.addEventListener('click', click);
  return node;
}

function notice(node, text = '') {
  node.textContent = text;
  node.hidden = !text;
}

const statusBox = () => chat.hidden ? $('#home-status') : $('#chat-status');

async function api(path, data) {
  let response;
  try {
    response = await fetch('/api/' + path, data === undefined ? {} : {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data),
    });
  } catch {
    throw new Error('Связь с ПК потеряна. Проверь, запущен ли Self-Manager.');
  }
  const payload = await response.json();
  if (!response.ok) throw new Error(payload.error || 'Не удалось выполнить запрос.');
  return payload.result ?? payload;
}

async function refresh() {
  const version = ++refreshVersion;
  const next = await api('state');
  if (version !== refreshVersion) return;
  if (state && JSON.stringify(state) === JSON.stringify(next)) return;
  state = next;
  render();
}

async function action(path, body) {
  const status = statusBox();
  notice(status);
  try {
    await api(path, body);
    await refresh();
  } catch (error) {
    notice(status, error.message);
  }
}

function dateTime(value, options) {
  return new Intl.DateTimeFormat('ru-RU', { timeZone: state.timeZone, ...options }).format(new Date(value));
}

const dayKey = (value) => new Intl.DateTimeFormat('sv-SE', { timeZone: state.timeZone }).format(new Date(value));
const clock = (value) => dateTime(value, { hour: '2-digit', minute: '2-digit' });
const stamp = (value) => dateTime(value, { dateStyle: 'short', timeStyle: 'short' });
const taskById = (id) => state.tasks.find((task) => task.id === id);
const itemById = (id) => state.inbox.find((item) => item.id === id);
const final = (task) => ['done', 'cancelled', 'merged'].includes(task.status);
const empty = (text) => el('p', 'muted', text);
const toIso = (value) => value ? new Date(value).toISOString() : undefined;
function localDate(value) {
  if (!value) return '';
  const local = new Date(value);
  return new Date(+local - local.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

function openChat(id = null) {
  if (dialog.open) dialog.close();
  itemId = id;
  requestDraft = undefined;
  input.value = '';
  previewDismissed = state?.messages.findLast((entry) => entry.role === 'legion')?.id;
  $('#home').hidden = true;
  chat.hidden = false;
  document.title = 'Self — Legion';
  notice($('#chat-status'));
  renderChat();
  input.focus({ preventScroll: true });
  scrollChat();
}

function scrollChat() {
  const scroll = $('#chat-scroll');
  scroll.scrollTop = scroll.scrollHeight;
}

function render() {
  const latest = state.messages.findLast((entry) => entry.role === 'legion');
  $('#entry-preview').textContent = latest && latest.id !== previewDismissed ? latest.text : 'Что у тебя на уме?';
  if (chat.hidden) renderHome();
  else {
    const scroll = $('#chat-scroll');
    const nearEnd = scroll.scrollHeight - scroll.clientHeight - scroll.scrollTop < 120;
    renderChat();
    if (nearEnd) scrollChat();
  }
}

function renderHome() {
  $('#view-title').textContent = titles[view];
  $('#subtitle').textContent = view === 'day'
    ? dateTime(new Date(), { weekday: 'long', day: 'numeric', month: 'long' }) : '';
  document.title = 'Self — ' + titles[view];
  for (const node of document.querySelectorAll('[data-view]')) {
    if (node.dataset.view === view) node.setAttribute('aria-current', 'page');
    else node.removeAttribute('aria-current');
  }
  content.replaceChildren();
  const pages = { day: renderDay, inbox: renderInbox, work: renderWork, memory: renderMemory };
  pages[view]();
}

function card(title, detail, controls = [], meta) {
  const box = el('article', 'card', el('h3', '', title));
  if (meta) box.append(el('p', 'meta', meta));
  if (detail) box.append(el('p', '', detail));
  if (controls.length) box.append(el('div', 'actions', ...controls));
  return box;
}

function renderDay() {
  const day = chosenDay || dayKey(new Date());
  const date = el('input');
  date.type = 'date';
  date.value = day;
  date.setAttribute('aria-label', 'День расписания');
  date.addEventListener('change', () => {
    chosenDay = date.value;
    renderHome();
    content.querySelector('input').focus();
  });
  content.append(el('div', 'actions', date, button('Сегодня', () => {
    chosenDay = '';
    renderHome();
  }), button('Занятое окно', editCommitment)));
  for (const reminder of state.reminders) {
    const task = taskById(reminder.taskId);
    const item = itemById(reminder.itemId);
    content.append(card(task?.title || item.original, reminder.text, [
      button('Открыть', () => task ? showTask(task.id) : openChat(item.id), 'primary'),
      button('Скрыть', () => action('reminders', { id: reminder.id })),
    ]));
  }
  const entries = [
    ...state.tasks.filter((task) => task.slot && task.status !== 'cancelled')
      .map((task) => ({ ...task.slot, title: task.title, task })),
    ...state.windows,
  ].filter((entry) => dayKey(entry.start) <= day && dayKey(+new Date(entry.end) - 1) >= day)
    .sort((a, b) => a.start.localeCompare(b.start));
  if (day === dayKey(new Date()) && entries.length) {
    const open = entries.filter((entry) => entry.task && !final(entry.task));
    const important = open.filter((entry) => entry.task.priority === 'high');
    const next = open.find((entry) => entry.end >= new Date().toISOString());
    const summary = 'Открытых задач: ' + open.length + ' · важных: ' + important.length +
      (next ? ' · ближайшая: ' + next.title + ' в ' + clock(next.start) : '');
    content.append(el('p', 'meta', summary));
  }
  if (!entries.length) {
    content.append(empty('На этот день пока нет согласованных окон. Расскажи Legion, что хочешь сделать.'));
    return;
  }
  const list = el('ol', 'schedule');
  list.setAttribute('aria-label', 'Расписание дня');
  for (const entry of entries) {
    const task = entry.task;
    const name = button(entry.title, () => task ? showTask(task.id) : showCommitment(entry), 'task-title');
    const badge = el('span', 'now', 'Сейчас');
    name.prepend(badge);
    name.append(el('span', 'meta', task ? labels[task.status] : 'Обязательство'));
    const from = dayKey(entry.start) < day ? '00:00' : clock(entry.start);
    const to = dayKey(entry.end) > day ? '24:00' : clock(entry.end);
    const row = el('li', 'task', name, el('span', 'task-time', from + '–' + to));
    row.dataset.start = entry.start;
    row.dataset.end = entry.end;
    list.append(row);
  }
  content.append(list);
  updateClock();
}

function updateClock() {
  if (!state || !chat.hidden || view !== 'day') return;
  const now = new Date().toISOString();
  const displayed = content.querySelector('input[type=date]');
  if (!chosenDay && displayed && displayed.value !== dayKey(now)) {
    renderHome();
    return;
  }
  for (const row of content.querySelectorAll('[data-start]')) {
    const active = row.dataset.start <= now && now < row.dataset.end;
    if (active) row.setAttribute('aria-current', 'time');
    else row.removeAttribute('aria-current');
    row.querySelector('.now').hidden = !active;
  }
}

function renderInbox() {
  content.append(el('div', 'actions',
    button('Новая мысль', () => openChat(), 'primary'),
    button(showArchive ? 'Показать очередь' : 'Показать всю историю', () => {
      showArchive = !showArchive;
      renderHome();
    })));
  const entries = state.inbox.filter((item) => showArchive || ['new', 'deferred'].includes(item.status));
  if (!entries.length) content.append(empty('Здесь будут мысли, к которым ещё нужно вернуться.'));
  for (const item of entries.toReversed()) {
    const meta = [labels[item.status], stamp(item.at), item.revisitAt && 'Вернуться ' + stamp(item.revisitAt)]
      .filter(Boolean).join(' · ');
    content.append(card(item.original, '', [button('Открыть', () => openChat(item.id))], meta));
  }
}

function renderWork() {
  const pending = state.proposals.filter((proposal) => proposal.status === 'pending');
  if (pending.length) content.append(el('h2', 'section-title', 'Ждут решения'), ...pending.map(proposalCard));
  for (const pair of state.duplicates) {
    const task = taskById(pair.to);
    content.append(card('Одинаковая работа · ' + task.title,
      'У двух действий совпадают название, результат, срок, приоритет и зависимости. Связи можно перенести к одному действию.',
      [button('Сравнить', () => reviewDuplicate(pair))]));
  }
  if (!state.tasks.length) content.append(empty('Здесь появятся действия и проекты после согласования.'));
  const ordered = state.tasks.toSorted((a, b) =>
    Number(final(a)) - Number(final(b)) || (a.due || '∞').localeCompare(b.due || '∞'));
  for (const task of ordered) {
    const meta = [labels[task.status], task.slot && stamp(task.slot.start), task.due && 'Срок ' + stamp(task.due)]
      .filter(Boolean).join(' · ');
    content.append(card(task.title, task.result, [button('Подробнее', () => showTask(task.id))], meta));
  }
}

function reviewDuplicate(pair) {
  const source = taskById(pair.from);
  const target = taskById(pair.to);
  edit('Объединить эквивалентную работу?', [
    el('p', '', 'Общий результат · ' + target.result),
    el('p', '', 'Первая мысль · ' + itemById(target.itemId).original),
    el('p', '', 'Вторая мысль · ' + itemById(source.itemId).original),
    el('p', 'muted', 'Общая задача получит связи обеих записей. Исходные мысли останутся в истории.'),
  ], () => api('merge', pair), 'Объединить');
}

function renderMemory() {
  if (!state.memory.length) content.append(empty('Наблюдения и предпочтения можно подтвердить из чата.'));
  for (const entry of state.memory.toReversed()) {
    const controls = [button('Уточнить', () => edit('Уточнить наблюдение', [
      field('text', 'Текст', 'textarea', entry.text, { required: true, maxLength: 6000 }),
    ], (values) => api('memory', { id: entry.id, text: values.text })))];
    if (entry.status === 'confirmed') controls.push(button('В архив', () => action('memory', { id: entry.id, archive: true })));
    content.append(card('Наблюдение', entry.text, controls, labels[entry.status] + ' · ' + stamp(entry.at)));
  }
}

function renderChat() {
  const log = $('#chat-history');
  const options = $('#chat-options');
  log.replaceChildren();
  options.replaceChildren();
  $('#cloud-mode').textContent = state?.cloud ? 'Облачный Legion' : 'Ручной режим';
  if (!state) return;
  const entries = state.messages.filter((entry) => entry.itemId === itemId);
  const item = itemById(itemId);
  if (!item) {
    log.append(el('p', 'message', 'Запиши мысль. Обсудить её можно сейчас или позже.'));
    return;
  }
  log.append(el('p', 'chat-date', labels[item.status] + ' · ' + stamp(item.at)));
  const seen = new Set();
  for (const entry of entries) {
    const author = el('span', 'sr-only', entry.role === 'legion' ? 'Legion: ' : 'Ты: ');
    log.append(el('p', entry.role === 'user' ? 'message message-user' : 'message', author, entry.text));
    const proposal = state.proposals.find((candidate) => candidate.id === entry.proposalId);
    if (proposal) {
      seen.add(proposal.id);
      log.append(proposalCard(proposal));
    }
  }
  for (const proposal of state.proposals.filter((entry) => entry.target === itemId && !seen.has(entry.id))) {
    log.append(proposalCard(proposal));
  }
  const latest = entries.findLast((entry) => entry.role === 'user');
  if (state.cloud && latest && !entries.some((entry) => entry.inReplyTo === latest.id)) {
    const ask = button('Получить ответ Legion', () => assist(latest.id, item.id));
    ask.disabled = waiting.has(item.id);
    options.append(ask);
  }
  if (['new', 'deferred'].includes(item.status)) {
    options.append(
      button('Составить план', () => editPlan(item)),
      button('Вернуться позже', () => edit('Отложить обсуждение', [
        field('revisitAt', 'Вернуться к мысли', 'datetime-local', localDate(Date.now() + 86_400_000), { required: true }),
      ], (values) => api('intents', { id: item.id, action: 'defer', revisitAt: toIso(values.revisitAt) }))),
      button('Сохранить как наблюдение', () => edit('Подтвердить запись памяти', [
        field('text', 'Что важно помнить', 'textarea', item.original, { required: true, maxLength: 6000 }),
      ], (values) => api('intents', { id: item.id, action: 'remember', text: values.text }))),
      button('Отменить намерение', () => edit('Отменить намерение?', [
        el('p', 'muted', 'Исходная мысль останется в истории.'),
      ], () => api('intents', { id: item.id, action: 'cancel' }), 'Отменить намерение')),
    );
  }
  if (['cancelled', 'deferred', 'memory'].includes(item.status)) {
    options.append(button('Вернуть к обсуждению', () => action('intents', { id: item.id, action: 'reopen' })));
  }
}

function proposalCard(proposal) {
  const payload = proposal.payload;
  const move = proposal.type === 'move';
  const task = taskById(move ? proposal.target : proposal.taskId);
  const slot = move ? payload : payload.slot;
  const details = [
    move ? (payload.previous ? 'Было ' + stamp(payload.previous.start) + '–' + clock(payload.previous.end) : 'Раньше без окна')
      : 'Результат · ' + payload.result,
    slot && 'Окно · ' + stamp(slot.start) + ' → ' + stamp(slot.end),
    payload.due && 'Срок · ' + stamp(payload.due),
    move && payload.previousDue && payload.previousDue !== payload.due && 'Прежний срок · ' + stamp(payload.previousDue),
    move && payload.previousDue && !payload.due && 'Предлагается снять срок',
    payload.reason,
    ...(payload.steps || []).map((step) => '• ' + step.title + ' · ' + step.result),
  ].filter(Boolean).join('\n');
  const controls = [];
  if (proposal.status === 'pending') {
    controls.push(
      button('Подтвердить', () => action('decisions', { id: proposal.id, accepted: true }), 'primary'),
      button('Отклонить', () => action('decisions', { id: proposal.id, accepted: false })),
    );
    if (move && task) controls.push(button('Другое время', () => editMove(task, payload)));
    if (proposal.type === 'plan') controls.push(button('Уточнить план', () => editPlan(itemById(proposal.target), payload)));
    if (proposal.type === 'step') controls.push(button('Уточнить шаг', () => editStep(taskById(proposal.target), payload)));
  }
  if (task) controls.push(button('К задаче', () => showTask(task.id)));
  const title = move ? (payload.previous ? 'Перенос' : 'Новое окно') + ' · ' + task.title : payload.title;
  return card(title, details, controls, labels[proposal.status] + ' · ' + authorName(proposal.by));
}

function authorName(by) {
  return { legion: 'Legion', system: 'Расписание', user: 'Ты' }[by] || by;
}

function field(name, label, type, value = '', attributes = {}) {
  let node;
  if (type === 'textarea') node = el('textarea');
  else if (type === 'select') {
    node = el('select');
    for (const [key, text] of attributes.choices) {
      const option = el('option', '', text);
      option.value = key;
      node.append(option);
    }
  } else {
    node = el('input');
    node.type = type;
  }
  node.name = name;
  node.value = value;
  for (const [key, value] of Object.entries(attributes)) if (key !== 'choices') node[key] = value;
  const wrapper = el('label', '', label, node);
  if (type === 'datetime-local' && state.timeZone !== browserZone) {
    wrapper.append(el('span', 'meta', 'Часовой пояс устройства · ' + browserZone));
  }
  return wrapper;
}

function edit(title, fields, onSave, saveLabel = 'Сохранить') {
  $('#editor-title').textContent = title;
  $('#fields').replaceChildren(...fields);
  $('#save-editor').textContent = saveLabel;
  $('#save-editor').hidden = !onSave;
  notice($('#form-error'));
  saveForm = onSave;
  if (!dialog.open) dialog.showModal();
  else (dialog.querySelector('input, select, textarea') || $('#close-editor')).focus();
}

function editPlan(item, draft = {}) {
  const steps = (draft.steps || []).map((step) => step.title + ' | ' + step.result).join('\n');
  edit('Предложить план', [
    field('title', 'Название действия или проекта', 'text', draft.title || item.original.trim().slice(0, 200), { required: true, maxLength: 200 }),
    field('result', 'Как поймёшь, что получилось?', 'textarea', draft.result || '', { required: true, maxLength: 1200 }),
    field('steps', 'Шаги проекта · один на строку, «шаг | результат»', 'textarea', steps, { maxLength: 8000 }),
    field('due', 'Срок', 'datetime-local', localDate(draft.due)),
    field('priority', 'Приоритет', 'select', draft.priority || 'normal', { choices: [['low', labels.low], ['normal', labels.normal], ['high', labels.high]] }),
    field('start', 'Начало окна', 'datetime-local', localDate(draft.slot?.start)),
    field('end', 'Конец окна', 'datetime-local', localDate(draft.slot?.end)),
    field('reason', 'Почему этот вариант подходит?', 'textarea', draft.reason || '', { maxLength: 1200 }),
  ], (values) => {
    const steps = values.steps.split('\n').map((line) => line.trim()).filter(Boolean).map((line) => {
      const [title, ...result] = line.split('|');
      return { title, result: result.join('|').trim() || title };
    });
    return api('proposals', { ...values, type: 'plan', target: item.id, steps,
      due: toIso(values.due), start: toIso(values.start), end: toIso(values.end) });
  }, 'Создать предложение');
}

function editMove(task, draft = task.slot || {}) {
  const due = 'due' in draft ? draft.due : task.due;
  edit(task.slot ? 'Предложить перенос' : 'Предложить время', [
    field('start', 'Начало окна', 'datetime-local', localDate(draft.start), { required: true }),
    field('end', 'Конец окна', 'datetime-local', localDate(draft.end), { required: true }),
    field('due', 'Срок', 'datetime-local', localDate(due)),
    field('reason', 'Что изменилось?', 'textarea', draft.reason || '', { maxLength: 1200 }),
  ], (values) => api('proposals', {
    ...values, type: 'move', target: task.id, start: toIso(values.start), end: toIso(values.end),
    due: values.due === localDate(task.due) ? undefined : toIso(values.due) ?? null,
  }), 'Создать предложение');
}

function editStep(task, draft = {}) {
  edit('Предложить следующий шаг', [
    field('title', 'Название шага', 'text', draft.title || '', { required: true, maxLength: 200 }),
    field('result', 'Как поймёшь, что получилось?', 'textarea', draft.result || '', { required: true, maxLength: 1200 }),
    field('due', 'Срок шага', 'datetime-local', localDate(draft.due || task.due)),
    field('reason', 'Зачем нужен этот шаг?', 'textarea', draft.reason || '', { maxLength: 1200 }),
  ], async (values) => {
    await api('proposals', { ...values, due: toIso(values.due), type: 'step', target: task.id });
    if (chat.hidden) view = 'work';
  }, 'Создать предложение');
}

function editSuggestion(task) {
  edit('Найти свободное окно', [
    field('start', 'Искать начиная с', 'datetime-local', localDate(Date.now() + 60_000), { required: true }),
    field('end', 'Искать до', 'datetime-local', localDate(Date.now() + 4 * 3_600_000), { required: true }),
    field('minutes', 'Продолжительность, минут', 'number', '30', { min: 5, max: 480, required: true }),
  ], async (values) => {
    await api('suggestions', { target: task.id, start: toIso(values.start), end: toIso(values.end), minutes: Number(values.minutes) });
    if (chat.hidden) view = 'work';
  }, 'Предложить окно');
}

function editCommitment() {
  edit('Добавить занятое окно', [
    field('title', 'Что запланировано?', 'text', '', { required: true, maxLength: 200 }),
    field('start', 'Начало', 'datetime-local', '', { required: true }),
    field('end', 'Окончание', 'datetime-local', '', { required: true }),
  ], (values) => api('commitments', { ...values, start: toIso(values.start), end: toIso(values.end) }));
}

function showCommitment(entry) {
  edit(entry.title, [el('p', '', stamp(entry.start) + ' → ' + stamp(entry.end))],
    () => api('commitments', { id: entry.id, remove: true }), 'Убрать занятое окно');
}

function showTask(id) {
  const task = taskById(id);
  if (task.status === 'merged') {
    edit(task.title, [
      el('p', '', 'Эта работа объединена с общей задачей.'),
      el('div', 'actions', button('К общей задаче', () => showTask(task.mergedInto))),
    ], () => api('merge', { undo: true, id }), 'Отменить объединение');
    return;
  }
  const children = state.relations.filter((edge) => edge.type === 'part_of' && edge.to === task.id);
  const controls = [];
  if (['ready', 'partial', 'missed'].includes(task.status) && !children.length) {
    controls.push(button('Начать', () => changeTask('execution', { id, action: 'start' }, id), 'primary'));
  }
  controls.push(button(final(task) ? 'Уточнить факты' : 'Указать результат', () => editResult(task, final(task))));
  if (!final(task) && !children.length) controls.push(
    button(task.slot ? 'Предложить перенос' : 'Выбрать время', () => editMove(task)),
    button('Найти свободное окно', () => editSuggestion(task)),
  );
  if (['ready', 'partial', 'missed'].includes(task.status) && !task.slot) {
    controls.push(button('Добавить следующий шаг', () => editStep(task)));
  }
  if (task.actualEnd && !final(task)) controls.push(button('Исправить историю', () => editResult(task, true)));
  controls.push(button('Добавить связь', () => editRelation(task)), button('Обсудить с Legion', () => openChat(task.itemId)));
  const details = [
    'Результат · ' + task.result,
    labels[task.status] + ' · приоритет ' + labels[task.priority].toLowerCase(),
    task.due && 'Срок · ' + stamp(task.due),
    task.slot && 'План · ' + stamp(task.slot.start) + ' → ' + stamp(task.slot.end),
    task.actualStart && 'Начато · ' + stamp(task.actualStart),
    task.actualEnd && 'Результат записан · ' + stamp(task.actualEnd),
    task.outcome,
  ].filter(Boolean).map((text) => el('div', '', text));
  for (const edge of state.relations.filter((entry) => entry.from === id || entry.to === id)) {
    const other = taskById(edge.from === id ? edge.to : edge.from);
    const text = edge.from === id ? labels[edge.type] + ' · ' + other.title
      : other.title + ' · ' + labels[edge.type] + ' этой записи';
    details.push(el('div', 'actions',
      button(text, () => showTask(other.id)), button('Снять связь', () => changeTask('relations', { id: edge.id, remove: true }, id))));
  }
  const history = state.history.filter((entry) => entry.target === id || entry.taskId === id);
  if (history.length) details.push(el('details', '', el('summary', '', 'История'),
    el('ol', 'history', ...history.toReversed().map(historyLine))));
  edit(task.title, [...details, el('div', 'actions', ...controls)], null);
}

function historyLine(entry) {
  const parts = [stamp(entry.at), eventLabels[entry.type] || entry.type, authorName(entry.by)];
  if (entry.before?.status && entry.after?.status) parts.push(labels[entry.before.status] + ' → ' + labels[entry.after.status]);
  if (entry.before?.outcome) parts.push('Было «' + entry.before.outcome + '»');
  if (entry.after?.outcome) parts.push('Записано «' + entry.after.outcome + '»');
  const proposal = state.proposals.find((candidate) => candidate.id === entry.proposalId);
  if (proposal?.type === 'move') {
    if (proposal.payload.previous) parts.push('Было ' + stamp(proposal.payload.previous.start));
    parts.push('Предложено ' + stamp(proposal.payload.start));
  }
  return el('li', '', parts.join(' · '));
}

async function changeTask(path, body, taskId) {
  notice($('#form-error'));
  try {
    await api(path, body);
    await refresh();
    if (dialog.open) showTask(taskId);
  } catch (error) {
    notice(dialog.open ? $('#form-error') : statusBox(), error.message);
  }
}

function editResult(task, correction) {
  const results = ['done', 'partial', 'missed', 'cancelled'].map((status) => [status, labels[status]]);
  edit(correction ? 'Уточнить фактическую историю' : 'Зафиксировать результат', [
    field('status', 'Что получилось?', 'select', results.some(([key]) => key === task.status) ? task.status : 'done', { choices: results }),
    field('actualStart', 'Фактическое начало', 'datetime-local', localDate(task.actualStart)),
    field('at', 'Фактическое окончание', 'datetime-local', localDate(correction ? task.actualEnd : null)),
    field('outcome', correction ? 'Что исправляешь и почему?' : 'Фактический результат', 'textarea', task.outcome, { required: correction, maxLength: 3000 }),
  ], (values) => api('execution', {
    ...values, id: task.id, action: correction ? 'correct' : 'result',
    actualStart: toIso(values.actualStart) ?? null, at: toIso(values.at),
  }));
}

function editRelation(task) {
  const others = state.tasks.filter((entry) => entry.id !== task.id);
  if (!others.length) return notice($('#form-error'), 'Сначала создай ещё одно действие или проект.');
  edit('Связать «' + task.title + '»', [
    field('type', 'Как связать?', 'select', 'part_of', { choices: [
      ['part_of', 'Входит в проект'], ['blocked_by', 'Зависит от'], ['contributes_to', 'Помогает цели'],
    ] }),
    field('to', 'С чем?', 'select', others[0].id, { choices: others.map((entry) => [entry.id, entry.title]) }),
  ], (values) => api('relations', { ...values, from: task.id }));
}

async function assist(id, target) {
  if (waiting.has(target)) return;
  waiting.add(target);
  const visible = () => !chat.hidden && itemId === target;
  if (visible()) {
    notice($('#chat-status'), 'Legion готовит ответ…');
    renderChat();
  }
  try {
    const result = await api('assist', { id });
    if (visible()) notice($('#chat-status'), result.warning);
    await refresh();
  } catch (error) {
    if (visible()) notice($('#chat-status'), error.message);
  } finally {
    waiting.delete(target);
    if (visible()) {
      renderChat();
      scrollChat();
    }
  }
}

$('#composer').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (sending || !input.value.trim()) return;
  const text = input.value;
  const source = itemId;
  if (requestDraft?.text !== text || requestDraft.itemId !== source) {
    requestDraft = { text, itemId: source, requestId: crypto.randomUUID() };
  }
  const draft = requestDraft;
  sending = true;
  const send = $('#composer button[type=submit]');
  send.disabled = true;
  notice($('#chat-status'));
  try {
    const result = await api('messages', draft);
    const sameThread = !chat.hidden && requestDraft === draft && source === itemId;
    if (sameThread) {
      itemId = result.itemId;
      if (input.value === text) input.value = '';
      requestDraft = undefined;
    }
    await refresh();
    if (sameThread && !chat.hidden && itemId === result.itemId) {
      scrollChat();
      input.focus({ preventScroll: true });
      if (state?.cloud) void assist(result.id, itemId);
    }
  } catch (error) {
    if (!chat.hidden && (requestDraft === draft || itemId === source)) notice($('#chat-status'), error.message);
  } finally {
    sending = false;
    send.disabled = false;
  }
});

$('#editor-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!saveForm) return;
  const save = $('#save-editor');
  const close = $('#close-editor');
  const values = Object.fromEntries(new FormData(event.currentTarget));
  save.disabled = close.disabled = true;
  notice($('#form-error'));
  try {
    await saveForm(values);
    dialog.close();
    await refresh();
  } catch (error) {
    notice(dialog.open ? $('#form-error') : statusBox(), error.message);
  } finally {
    save.disabled = close.disabled = false;
  }
});
dialog.addEventListener('cancel', (event) => {
  if ($('#save-editor').disabled) event.preventDefault();
});
$('#close-editor').addEventListener('click', () => dialog.close());
$('#new-chat').addEventListener('click', () => {
  const latest = state?.messages.findLast((entry) => entry.role === 'legion');
  openChat(latest?.id !== previewDismissed ? latest?.itemId : null);
});
$('#back').addEventListener('click', () => {
  chat.hidden = true;
  $('#home').hidden = false;
  if (state) render();
  $('#new-chat').focus({ preventScroll: true });
});
for (const node of document.querySelectorAll('[data-view]')) {
  node.addEventListener('click', () => {
    if (!state) return;
    view = node.dataset.view;
    notice($('#home-status'));
    renderHome();
  });
}

const Speech = window.SpeechRecognition || window.webkitSpeechRecognition;
if (Speech) {
  const dictate = $('#dictate');
  dictate.hidden = false;
  dictate.addEventListener('click', () => {
    const recognition = new Speech();
    const startingItem = itemId;
    recognition.lang = 'ru-RU';
    recognition.onresult = (event) => {
      if (!chat.hidden && itemId === startingItem) {
        input.value = [input.value, event.results[0][0].transcript].filter(Boolean).join(' ').slice(0, 6000);
        input.focus();
      }
    };
    recognition.onerror = () => notice($('#chat-status'), 'Диктовка недоступна. Можно ввести текст вручную.');
    recognition.onend = () => { dictate.disabled = false; };
    try {
      recognition.start();
      dictate.disabled = true;
    } catch {
      notice($('#chat-status'), 'Не удалось начать диктовку.');
    }
  });
}

async function sync() {
  const status = statusBox();
  try {
    await refresh();
    if (status.dataset.connectionError) {
      notice(status);
      delete status.dataset.connectionError;
    }
  } catch (error) {
    if (status.hidden || status.dataset.connectionError) {
      status.dataset.connectionError = '1';
      notice(status, error.message);
    }
  }
}

void sync();
setInterval(() => { if (!document.hidden) void sync(); }, 15_000);
setInterval(updateClock, 1000);
document.addEventListener('visibilitychange', () => { if (!document.hidden) void sync(); });
window.addEventListener('online', sync);
if ('serviceWorker' in navigator) void navigator.serviceWorker.register('/sw.js').catch(() => {});
