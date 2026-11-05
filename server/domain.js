import { randomUUID } from 'node:crypto';

export class InputError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

export const isoNow = () => new Date().toISOString();
const id = () => randomUUID();

export function required(value, name, max = 1000) {
  if (typeof value !== 'string' || !value.trim() || value.length > max) {
    throw new InputError(name + ' должно содержать от 1 до ' + max + ' символов.');
  }
  return value.trim();
}

function optional(value, name, max) {
  return value === undefined || value === null || value === '' ? '' : required(value, name, max);
}

export function find(rows, rowId) {
  const row = rows.find((entry) => entry.id === rowId);
  if (!row) throw new InputError('Запись не найдена.', 404);
  return row;
}

function instant(value, name) {
  if (typeof value !== 'string' || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,3})?(?:Z|[+-]\d\d:\d\d)$/.test(value)) {
    throw new InputError(name + ' должно содержать дату, время и часовой пояс.');
  }
  const parsed = new Date(value);
  if (!Number.isFinite(+parsed)) throw new InputError('Некорректная дата.');
  const calendar = new Date(value.slice(0, 10) + 'T00:00:00Z');
  if (!Number.isFinite(+calendar) || calendar.toISOString().slice(0, 10) !== value.slice(0, 10) ||
    Number(value.slice(11, 13)) > 23) throw new InputError('Некорректная дата или время.');
  return parsed.toISOString();
}

function interval(start, end) {
  const from = instant(start, 'Начало');
  const to = instant(end, 'Окончание');
  if (from >= to) throw new InputError('Окончание должно быть позже начала.');
  return { start: from, end: to };
}

function event(data, type, target, details = {}, by = 'user') {
  data.history.push({ id: id(), at: isoNow(), type, target, by, ...details });
}

export function message(data, itemId, role, text, extra = {}) {
  const entry = { id: id(), itemId, role, text, at: isoNow(), ...extra };
  data.messages.push(entry);
  return entry;
}

export function capture(data, body) {
  required(body.text, 'Сообщение', 6000);
  const requestId = required(body.requestId, 'Идентификатор', 80);
  const existing = data.messages.find((entry) => entry.requestId === requestId);
  if (existing) {
    if (existing.text !== body.text || (body.itemId && body.itemId !== existing.itemId)) {
      throw new InputError('Идентификатор уже использован для другого сообщения.', 409);
    }
    return existing;
  }
  let item;
  if (body.itemId) {
    item = find(data.inbox, body.itemId);
  } else {
    item = { id: id(), original: body.text, at: isoNow(), status: 'new', revisitAt: null };
    data.inbox.push(item);
    event(data, 'captured', item.id);
  }
  return message(data, item.id, 'user', body.text, { requestId });
}

function archivePending(data, type, target) {
  for (const proposal of data.proposals) {
    if (proposal.type === type && proposal.target === target && proposal.status === 'pending') {
      proposal.status = 'superseded';
    }
  }
}

export function changeIntent(data, itemId, body) {
  const item = find(data.inbox, itemId);
  const before = { status: item.status, revisitAt: item.revisitAt };
  switch (body.action) {
    case 'defer':
      item.revisitAt = instant(body.revisitAt, 'Дата возвращения');
      item.status = 'deferred';
      break;
    case 'reopen':
      item.revisitAt = null;
      item.status = 'new';
      break;
    case 'cancel':
      item.revisitAt = null;
      item.status = 'cancelled';
      break;
    case 'remember': {
      if (item.status === 'memory') throw new InputError('Мысль уже сохранена в памяти.', 409);
      const text = required(body.text ?? item.original, 'Запись памяти', 6000);
      data.memory.push({ id: id(), itemId, text, at: isoNow(), status: 'confirmed' });
      item.revisitAt = null;
      item.status = 'memory';
      break;
    }
    default:
      throw new InputError('Неизвестное действие для намерения.');
  }
  archivePending(data, 'plan', item.id);
  event(data, 'intent', item.id, { before, after: { status: item.status, revisitAt: item.revisitAt } });
}

export function reviseMemory(data, memoryId, body) {
  const entry = find(data.memory, memoryId);
  const before = { text: entry.text, status: entry.status };
  if (body.archive === true) entry.status = 'archived';
  else {
    entry.text = required(body.text, 'Запись памяти', 6000);
    entry.status = 'confirmed';
  }
  event(data, 'memory', memoryId, { before, after: { text: entry.text, status: entry.status } });
}

function checkSlot(data, slot, except) {
  if (!slot) return;
  const overlap = (other) => other.start < slot.end && slot.start < other.end;
  const conflict = data.tasks.find((task) => task.id !== except && task.status !== 'cancelled' && task.slot && overlap(task.slot));
  const commitment = data.windows.find(overlap);
  if (conflict || commitment) {
    throw new InputError('Это окно пересекается с записью «' + (conflict || commitment).title + '».', 409);
  }
}

function normalizePlan(body) {
  const steps = Array.isArray(body.steps) ? body.steps : [];
  if (steps.length > 10) throw new InputError('Предложи до 10 ближайших шагов.');
  const plan = {
    title: required(body.title, 'Название', 200),
    result: required(body.result, 'Желаемый результат', 1200),
    reason: optional(body.reason, 'Обоснование', 1200),
    due: body.due ? instant(body.due, 'Срок') : null,
    priority: ['low', 'normal', 'high'].includes(body.priority) ? body.priority : 'normal',
    slot: body.start || body.end ? interval(body.start, body.end) : null,
    steps: steps.map((step) => ({
      title: required(step?.title, 'Название шага', 200),
      result: required(step?.result, 'Результат шага', 1200),
    })),
  };
  if (plan.steps.length && plan.slot) throw new InputError('Время нужно назначать отдельным шагам.');
  if (plan.due && plan.slot?.end > plan.due) throw new InputError('Окно заканчивается после срока.');
  return plan;
}

const movableStatuses = ['ready', 'active', 'partial', 'missed'];

function checkTaskSlot(data, task, slot) {
  if (task.due && slot.end > task.due) throw new InputError('Окно заканчивается после срока.');
  for (const edge of data.relations.filter((entry) => entry.type === 'blocked_by' && touches(entry, task.id))) {
    if (edge.from === task.id) {
      const dependency = find(data.tasks, edge.to);
      if (dependency.status !== 'done' && (!dependency.slot || dependency.slot.end > slot.start)) {
        throw new InputError('Сначала запланируй или заверши «' + dependency.title + '».', 409);
      }
    } else {
      const dependent = find(data.tasks, edge.from);
      if (task.status !== 'done' && dependent.slot && !finalStatuses.includes(dependent.status) && slot.end > dependent.slot.start) {
        throw new InputError('Это окно заканчивается после начала зависимой задачи «' + dependent.title + '».', 409);
      }
    }
  }
  checkSlot(data, slot, task.id);
}

export function suggestSlot(data, body) {
  const task = find(data.tasks, body.target);
  const range = interval(body.start, body.end);
  const minutes = body.minutes;
  if (!Number.isInteger(minutes) || minutes < 5 || minutes > 480) {
    throw new InputError('Продолжительность должна быть от 5 до 480 минут.');
  }
  const duration = minutes * 60_000;
  let limit = Math.min(+new Date(range.end), task.due ? +new Date(task.due) : Infinity);
  let cursor = Math.max(+new Date(range.start), Math.ceil(Date.now() / 60_000) * 60_000);
  for (const edge of data.relations.filter((entry) => entry.type === 'blocked_by' && touches(entry, task.id))) {
    const prerequisite = edge.from === task.id;
    const other = find(data.tasks, prerequisite ? edge.to : edge.from);
    if (prerequisite && other.status !== 'done') {
      if (!other.slot) throw new InputError('Сначала запланируй или заверши «' + other.title + '».', 409);
      cursor = Math.max(cursor, +new Date(other.slot.end));
    } else if (!prerequisite && other.slot && !finalStatuses.includes(other.status)) {
      limit = Math.min(limit, +new Date(other.slot.start));
    }
  }
  const occupied = [
    ...data.windows,
    ...data.tasks.filter((entry) => entry.slot && entry.id !== task.id && entry.status !== 'cancelled')
      .map((entry) => entry.slot),
  ].sort((first, second) => first.start.localeCompare(second.start));
  for (const slot of occupied) {
    if (+new Date(slot.start) >= cursor + duration) break;
    cursor = Math.max(cursor, +new Date(slot.end));
  }
  if (cursor + duration > limit) throw new InputError('В указанном диапазоне нет свободного окна до срока.', 409);
  return propose(data, {
    type: 'move', target: task.id,
    start: new Date(cursor).toISOString(), end: new Date(cursor + duration).toISOString(),
    reason: 'Первое свободное окно нужной длительности в выбранном диапазоне.',
  }, 'system');
}

export function propose(data, body, by = 'user') {
  let payload;
  if (body.type === 'plan') {
    const item = find(data.inbox, body.target);
    if (!['new', 'deferred'].includes(item.status)) {
      throw new InputError('Сначала верни намерение к обсуждению.', 409);
    }
    payload = normalizePlan(body);
    checkSlot(data, payload.slot);
  } else if (body.type === 'step') {
    const parent = find(data.tasks, body.target);
    if (!['ready', 'partial', 'missed'].includes(parent.status) || parent.slot) {
      throw new InputError('Добавление шага доступно в открытом проекте без собственного окна.', 409);
    }
    payload = normalizePlan({ ...body, steps: [], priority: parent.priority, due: body.due || parent.due });
    if (parent.due && payload.due > parent.due) throw new InputError('Срок шага позже срока проекта.');
    checkSlot(data, payload.slot);
  } else if (body.type === 'move') {
    const task = find(data.tasks, body.target);
    if (!movableStatuses.includes(task.status)) {
      throw new InputError('У завершённой или отменённой задачи нельзя менять расписание.', 409);
    }
    if (data.relations.some((edge) => edge.type === 'part_of' && edge.to === task.id)) {
      throw new InputError('Для проекта выбери конкретный шаг.');
    }
    const due = body.due === undefined ? task.due : body.due ? instant(body.due, 'Новый срок') : null;
    payload = {
      ...interval(body.start, body.end),
      reason: optional(body.reason, 'Обоснование', 1200),
      previous: task.slot, due, previousDue: task.due,
    };
    if (due !== task.due) required(payload.reason, 'Причина изменения срока', 1200);
    checkTaskSlot(data, { ...task, due }, payload);
  } else {
    throw new InputError('Неизвестное предложение.');
  }
  const target = body.target;
  archivePending(data, body.type, target);
  const proposal = { id: id(), type: body.type, target, by, payload, status: 'pending', at: isoNow() };
  data.proposals.push(proposal);
  event(data, 'proposed', target, { proposalId: proposal.id }, by);
  return proposal;
}

function makeTask(data, itemId, payload) {
  const task = {
    id: id(), itemId, title: payload.title, result: payload.result, due: payload.due ?? null,
    priority: payload.priority || 'normal', slot: payload.slot ?? null, status: 'ready',
    actualStart: null, actualEnd: null, outcome: '', at: isoNow(),
  };
  data.tasks.push(task);
  return task;
}

export function decide(data, proposalId, accepted) {
  if (typeof accepted !== 'boolean') throw new InputError('Укажи решение.');
  const proposal = find(data.proposals, proposalId);
  const status = accepted ? 'accepted' : 'rejected';
  if (proposal.status === status) return proposal;
  if (proposal.status !== 'pending') throw new InputError('Это предложение уже закрыто.', 409);
  if (accepted && proposal.type === 'plan') {
    const item = find(data.inbox, proposal.target);
    if (!['new', 'deferred'].includes(item.status)) throw new InputError('Намерение уже разобрано.', 409);
    const payload = proposal.payload;
    checkSlot(data, payload.slot);
    const task = makeTask(data, item.id, payload);
    for (const step of payload.steps) {
      const child = makeTask(data, item.id, { ...step, due: payload.due, priority: payload.priority });
      data.relations.push({ id: id(), type: 'part_of', from: child.id, to: task.id });
    }
    item.status = 'planned';
    item.revisitAt = null;
    proposal.taskId = task.id;
  }
  if (accepted && proposal.type === 'step') {
    const parent = find(data.tasks, proposal.target);
    if (!['ready', 'partial', 'missed'].includes(parent.status) || parent.slot) {
      throw new InputError('Проект изменился. Проверь план.', 409);
    }
    checkSlot(data, proposal.payload.slot);
    const child = makeTask(data, parent.itemId, proposal.payload);
    addRelation(data, { type: 'part_of', from: child.id, to: parent.id });
    proposal.taskId = child.id;
  }
  if (accepted && proposal.type === 'move') {
    const task = find(data.tasks, proposal.target);
    if (!movableStatuses.includes(task.status)) {
      throw new InputError('Состояние задачи изменилось. Перенос недоступен.', 409);
    }
    if (data.relations.some((edge) => edge.type === 'part_of' && edge.to === task.id)) {
      throw new InputError('Для проекта выбери конкретный шаг.');
    }
    const { start, end, previous, due = task.due, previousDue = task.due } = proposal.payload;
    if (JSON.stringify(task.slot) !== JSON.stringify(previous)) throw new InputError('Расписание уже изменилось.', 409);
    if (task.due !== previousDue) throw new InputError('Срок уже изменился.', 409);
    checkTaskSlot(data, { ...task, due }, { start, end });
    task.slot = { start, end };
    task.due = due;
  }
  proposal.status = status;
  proposal.decidedAt = isoNow();
  event(data, status, proposal.target, { proposalId, taskId: proposal.taskId });
  return proposal;
}

export function addWindow(data, body) {
  const window = { id: id(), title: required(body.title, 'Название', 200), ...interval(body.start, body.end) };
  checkSlot(data, window);
  data.windows.push(window);
  event(data, 'commitment', window.id, { after: window });
}

export function removeWindow(data, windowId) {
  const window = find(data.windows, windowId);
  data.windows = data.windows.filter((entry) => entry.id !== windowId);
  event(data, 'removed_commitment', windowId, { before: window });
}

const finalStatuses = ['done', 'cancelled', 'merged'];

export function recordExecution(data, taskId, body) {
  const task = find(data.tasks, taskId);
  if (task.status === 'merged') throw new InputError('Сначала разъедини работы или открой общую задачу.', 409);
  const before = { status: task.status, actualStart: task.actualStart, actualEnd: task.actualEnd, outcome: task.outcome };
  if (body.action === 'start') {
    if (!['ready', 'partial', 'missed'].includes(task.status)) throw new InputError('Задачу сейчас нельзя начать.', 409);
    if (data.relations.some((edge) => edge.type === 'part_of' && edge.to === task.id)) {
      throw new InputError('Для проекта выбери конкретный шаг.');
    }
    const blocked = data.relations.some((edge) => edge.from === task.id && edge.type === 'blocked_by' &&
      find(data.tasks, edge.to).status !== 'done');
    if (blocked) throw new InputError('Сначала заверши задачи, от которых зависит этот шаг.', 409);
    task.actualStart = body.at ? instant(body.at, 'Начало') : isoNow();
    task.actualEnd = null;
    task.status = 'active';
  } else if (body.action === 'result' || body.action === 'correct') {
    if (!['done', 'partial', 'missed', 'cancelled'].includes(body.status)) {
      throw new InputError('Выбери фактический результат.');
    }
    if (finalStatuses.includes(task.status) && body.action !== 'correct') {
      throw new InputError('Для изменения закрытой задачи используй исправление.', 409);
    }
    task.status = body.status;
    if (body.actualStart !== undefined) {
      task.actualStart = body.actualStart === null ? null : instant(body.actualStart, 'Начало');
    }
    task.actualEnd = body.at ? instant(body.at, 'Окончание') : isoNow();
    if (task.actualStart && task.actualStart > task.actualEnd) {
      throw new InputError('Фактическое окончание раньше начала.');
    }
    task.outcome = optional(body.outcome, 'Описание результата', 3000);
    if (body.action === 'correct') required(task.outcome, 'Причина исправления', 3000);
    if (body.status === 'done') {
      const children = data.relations.filter((edge) => edge.type === 'part_of' && edge.to === task.id);
      if (children.length) {
        required(task.outcome, 'Итог проекта', 3000);
        if (children.some((edge) => !finalStatuses.includes(find(data.tasks, edge.from).status))) {
          throw new InputError('Сначала зафиксируй результат или отмену оставшихся шагов.', 409);
        }
      }
    }
  } else {
    throw new InputError('Неизвестное действие выполнения.');
  }
  if (finalStatuses.includes(task.status)) archivePending(data, 'move', task.id);
  if (finalStatuses.includes(task.status)) archivePending(data, 'step', task.id);
  const after = { status: task.status, actualStart: task.actualStart, actualEnd: task.actualEnd, outcome: task.outcome };
  event(data, body.action, task.id, { before, after });
}

function reachable(edges, from, target) {
  const seen = new Set();
  const queue = [from];
  while (queue.length) {
    const next = queue.pop();
    if (next === target) return true;
    if (seen.has(next)) continue;
    seen.add(next);
    for (const edge of edges) if (edge.from === next) queue.push(edge.to);
  }
  return false;
}

export function addRelation(data, body, relationId = id()) {
  const source = find(data.tasks, body.from);
  const target = find(data.tasks, body.to);
  if ([source, target].some((task) => task.status === 'merged')) {
    throw new InputError('Выбери активную версию задачи.');
  }
  const { id: from } = source;
  const { id: to } = target;
  const type = body.type;
  if (!['part_of', 'blocked_by', 'contributes_to'].includes(type) || from === to) {
    throw new InputError('Выбери разные задачи и допустимую связь.');
  }
  if (data.relations.some((edge) => edge.type === type && edge.from === from && edge.to === to)) return;
  if (type === 'part_of' && find(data.tasks, to).slot) {
    throw new InputError('У родительской задачи есть время в расписании.', 409);
  }
  if (type === 'blocked_by' && source.slot && !finalStatuses.includes(source.status) && target.status !== 'done' &&
    (!target.slot || target.slot.end > source.slot.start)) {
    throw new InputError('Окно зависимой задачи должно быть после окна предшествующей задачи.', 409);
  }
  if (type !== 'contributes_to') {
    const dependencies = data.relations.filter((edge) => edge.type !== 'contributes_to')
      .map((edge) => edge.type === 'part_of' ? { from: edge.to, to: edge.from } : edge);
    const cycle = type === 'part_of' ? reachable(dependencies, from, to) : reachable(dependencies, to, from);
    if (cycle) throw new InputError('Эта связь образует цикл.', 409);
  }
  const relation = { id: relationId, from, to, type };
  data.relations.push(relation);
  event(data, 'linked', relation.id, { after: relation });
}

export function removeRelation(data, relationId) {
  const relation = find(data.relations, relationId);
  data.relations = data.relations.filter((entry) => entry.id !== relationId);
  event(data, 'unlinked', relationId, { before: relation });
}

const normalized = (text) => text.trim().replace(/\s+/g, ' ').toLocaleLowerCase('ru-RU');
const touches = (edge, taskId) => edge.from === taskId || edge.to === taskId;

function prerequisites(data, taskId) {
  return data.relations.filter((edge) => edge.type === 'blocked_by' && edge.from === taskId)
    .map((edge) => edge.to).sort().join(',');
}

function mergeable(data, source, target) {
  return source.id !== target.id && source.status === 'ready' && target.status === 'ready' &&
    !source.slot && !target.slot && !source.actualStart && !target.actualStart &&
    source.due === target.due && source.priority === target.priority &&
    normalized(source.title) === normalized(target.title) && normalized(source.result) === normalized(target.result) &&
    !data.relations.some((edge) => edge.type === 'part_of' && [source.id, target.id].includes(edge.to)) &&
    prerequisites(data, source.id) === prerequisites(data, target.id);
}

export function duplicateCandidates(data) {
  const groups = new Map();
  for (const task of data.tasks) {
    if (task.status !== 'ready' || task.slot) continue;
    const key = JSON.stringify([normalized(task.title), normalized(task.result), task.priority, task.due]);
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(task);
  }
  const candidates = [];
  for (const group of groups.values()) {
    for (let index = 1; index < group.length; index++) {
      const source = group[index];
      const target = group.slice(0, index).find((entry) => mergeable(data, source, entry));
      if (target) candidates.push({ from: source.id, to: target.id });
    }
  }
  return candidates;
}

export function mergeTasks(data, body) {
  const source = find(data.tasks, body.from);
  const target = find(data.tasks, body.to);
  if (!mergeable(data, source, target)) {
    throw new InputError('Для объединения нужны две эквивалентные задачи без расписания и фактических результатов.', 409);
  }
  const before = data.relations.filter((edge) => touches(edge, source.id));
  const after = [];
  data.relations = data.relations.filter((edge) => !touches(edge, source.id));
  for (const edge of before) {
    const from = edge.from === source.id ? target.id : edge.from;
    const to = edge.to === source.id ? target.id : edge.to;
    const existing = data.relations.find((candidate) => candidate.type === edge.type &&
      candidate.from === from && candidate.to === to);
    if (!existing) {
      addRelation(data, { from, to, type: edge.type });
      after.push(data.relations.at(-1));
    }
  }
  source.status = 'merged';
  source.mergedInto = target.id;
  source.merge = {
    before, after, targetEdges: data.relations.filter((edge) => touches(edge, target.id)),
  };
  archivePending(data, 'move', source.id);
  event(data, 'merged', source.id, { taskId: target.id, before, after });
}

export function undoMerge(data, taskId) {
  const source = find(data.tasks, taskId);
  if (source.status !== 'merged') throw new InputError('Задача не объединена.', 409);
  const target = find(data.tasks, source.mergedInto);
  const { before, after, targetEdges } = source.merge;
  const edgeIds = (edges) => edges.map((edge) => edge.id).sort().join(',');
  if (target.status === 'merged' ||
    edgeIds(data.relations.filter((edge) => touches(edge, target.id))) !== edgeIds(targetEdges)) {
    throw new InputError('Связи общей задачи изменились. Восстанови их состояние после объединения.', 409);
  }
  const removed = new Set(after.map((edge) => edge.id));
  data.relations = data.relations.filter((edge) => !removed.has(edge.id));
  source.status = 'ready';
  delete source.mergedInto;
  delete source.merge;
  for (const edge of before) addRelation(data, edge, edge.id);
  event(data, 'unmerged', source.id, { taskId: target.id, before: after, after: before });
}

export function reminders(data, now = isoNow()) {
  const list = [];
  for (const item of data.inbox) {
    if (item.status === 'deferred' && item.revisitAt <= now) {
      list.push({ id: item.id + ':revisit:' + item.revisitAt, itemId: item.id, text: 'Пора вернуться к отложенной мысли.' });
    } else if (item.status === 'new' && +new Date(now) - +new Date(item.at) >= 7 * 86_400_000) {
      const latest = data.messages.findLast((entry) => entry.itemId === item.id && entry.role === 'user');
      if (latest && +new Date(now) - +new Date(latest.at) >= 7 * 86_400_000) {
        list.push({ id: item.id + ':review:' + latest.id, itemId: item.id, text: 'Давно не обсуждали эту мысль. Она ещё актуальна?' });
      }
    }
  }
  for (const task of data.tasks) {
    if (!task.slot || finalStatuses.includes(task.status)) continue;
    const { start, end } = task.slot;
    if (task.actualEnd && task.actualEnd >= start) continue;
    let phase;
    let text;
    if (end <= now) {
      phase = 'result';
      text = 'Окно закончилось. Уточни, что получилось, или выбери перенос.';
    } else if (start <= now && task.status !== 'active') {
      phase = 'start';
      text = 'Пора начать, если ты готов.';
    } else if (task.status === 'active' && +new Date(end) - +new Date(now) <= 300_000) {
      phase = 'progress';
      text = 'Окно скоро закончится. Как продвигается работа?';
    } else if (task.status !== 'active' && task.priority === 'high' && now < start &&
      +new Date(start) - +new Date(now) <= 600_000) {
      phase = 'prepare';
      text = 'Скоро начнётся важная задача. У тебя всё готово?';
    }
    if (phase) list.push({ id: task.id + ':' + phase + ':' + start + ':' + end, taskId: task.id, text });
  }
  const dismissed = new Set(data.dismissed);
  return list.filter((entry) => !dismissed.has(entry.id));
}

export function dismiss(data, reminderId) {
  if (reminders(data).some((entry) => entry.id === reminderId)) data.dismissed.push(reminderId);
}
