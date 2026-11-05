const schedule = document.querySelector('#schedule');
const openedAt = new Date();
const clockFormat = new Intl.DateTimeFormat('ru-RU', { hour: '2-digit', minute: '2-digit' });
const dateFormat = new Intl.DateTimeFormat('ru-RU', { weekday: 'long', day: 'numeric', month: 'long' });
const dayStart = new Date(openedAt.getFullYear(), openedAt.getMonth(), openedAt.getDate());
const dayEnd = new Date(openedAt.getFullYear(), openedAt.getMonth(), openedAt.getDate() + 1);
const slotStart = new Date(openedAt);
slotStart.setMinutes(Math.floor(slotStart.getMinutes() / 30) * 30, 0, 0);

// Build a sample day around the time the prototype was opened.
const sampleTasks = [
  ['Собрать мысли на день', -90, -60],
  ['Разобрать заметки', -60, -30],
  ['Проверить план дня', -30, 0],
  ['Почитать и сделать заметку', 0, 30],
  ['Сделать перерыв', 30, 45],
  ['Записать следующий шаг', 45, 75],
];

document.querySelector('#today-date').textContent = dateFormat.format(openedAt);

const slots = [];
for (const [title, startOffset, endOffset] of sampleTasks) {
  const start = Math.max(+dayStart, +slotStart + startOffset * 60_000);
  const end = Math.min(+dayEnd, +slotStart + endOffset * 60_000);
  if (end <= start) continue;

  const row = document.createElement('li');
  row.className = 'task';
  const name = document.createElement('div');
  name.className = 'task-title';
  const current = document.createElement('span');
  current.className = 'now';
  current.textContent = 'Сейчас';
  current.hidden = true;
  name.append(current, title);
  const time = document.createElement('span');
  time.className = 'task-time';
  time.textContent = `${clockFormat.format(start)}–${end === +dayEnd ? '24:00' : clockFormat.format(end)}`;
  row.append(name, time);
  schedule.append(row);
  slots.push({ start, end, row, current });
}

function updateCurrentTask() {
  const now = Date.now();
  for (const { start, end, row, current } of slots) {
    const isCurrent = start <= now && now < end;
    if (isCurrent) row.setAttribute('aria-current', 'time');
    else row.removeAttribute('aria-current');
    current.hidden = !isCurrent;
  }
}

updateCurrentTask();
setInterval(updateCurrentTask, 1000);
document.addEventListener('visibilitychange', updateCurrentTask);

const day = document.querySelector('#day-screen');
const chat = document.querySelector('#chat-screen');
const openChat = document.querySelector('#open-chat');
const input = document.querySelector('#chat-input');
const historyLog = document.querySelector('#chat-history');
const chatScroll = document.querySelector('#chat-scroll');

function scrollToLatest() {
  chatScroll.scrollTop = chatScroll.scrollHeight;
}

function showDay() {
  chat.hidden = true;
  day.hidden = false;
  document.title = 'Self — Сегодня';
  openChat.focus({ preventScroll: true });
}

openChat.addEventListener('click', () => {
  document.querySelector('#entry-preview').textContent = 'Что у тебя на уме?';
  day.hidden = true;
  chat.hidden = false;
  document.title = 'Self — Legion';
  // Keep focus within the original tap so mobile browsers can open the keyboard.
  input.focus({ preventScroll: true });
  scrollToLatest();
});

document.querySelector('#back-to-day').addEventListener('click', showDay);

document.querySelector('#chat-form').addEventListener('submit', (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (!text) return;

  const message = document.createElement('p');
  message.className = 'message message-user';
  const author = document.createElement('span');
  author.className = 'sr-only';
  author.textContent = 'Ты: ';
  message.append(author, text);
  historyLog.append(message);
  input.value = '';
  input.focus({ preventScroll: true });
  scrollToLatest();
});
