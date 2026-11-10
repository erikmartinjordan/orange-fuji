const traySurface = document.getElementById('tray-surface');
const historyStage = document.getElementById('history-stage');
const historyClear = document.getElementById('history-clear');
const historyCount = document.getElementById('history-count');
const trayMenu = window.pico?.trayMenu;

function formatCardTitle(item) {
  const mode = String(item?.mode || 'capture');
  const label = mode.charAt(0).toUpperCase() + mode.slice(1);
  try {
    const time = new Date(item.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `${label} · ${time}`;
  } catch (_) {
    return label;
  }
}

function reportHeight() {
  requestAnimationFrame(() => {
    const height = Math.ceil(traySurface.getBoundingClientRect().height + 0.5);
    trayMenu?.resize(height);
  });
}

function renderHistory(history = {}) {
  const items = Array.isArray(history.items) ? history.items.slice(0, 5) : [];
  const total = Number(history.total) || items.length;

  historyStage.replaceChildren();

  if (!items.length) {
    const empty = document.createElement('div');
    empty.className = 'history-empty';
    empty.textContent = 'No captures yet';
    historyStage.appendChild(empty);
    historyClear.hidden = true;
    historyCount.textContent = '';
    historyCount.dataset.visible = 'false';
    return;
  }

  historyClear.hidden = false;
  historyCount.textContent = String(total);
  historyCount.dataset.visible = total > items.length ? 'true' : 'false';

  items.forEach((item) => {
    const card = document.createElement('button');
    card.type = 'button';
    card.className = 'capture-card';
    card.dataset.id = item.id;
    card.title = formatCardTitle(item);
    card.setAttribute('aria-label', `Open ${formatCardTitle(item)}`);
    const image = document.createElement('img');
    image.src = item.thumb;
    image.alt = '';
    image.draggable = false;
    card.appendChild(image);
    historyStage.appendChild(card);
  });
}

function render(data = {}) {
  renderHistory(data.history || {});
  reportHeight();
}

function sendAction(action, payload) {
  trayMenu?.action(action, payload);
}

document.addEventListener('click', (event) => {
  const actionTarget = event.target.closest('[data-action]');
  if (actionTarget) {
    sendAction(actionTarget.dataset.action);
    return;
  }
  const card = event.target.closest('.capture-card');
  if (card?.dataset.id) {
    sendAction('history-open', { id: card.dataset.id });
  }
});

historyClear.addEventListener('click', (event) => {
  event.stopPropagation();
  sendAction('history-clear');
});

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    event.preventDefault();
    trayMenu?.close();
  }
});

trayMenu?.onRefresh((data) => {
  render(data || {});
});

const initialData = trayMenu?.getData?.();
if (initialData?.then) {
  initialData
    .then((data) => {
      render(data || {});
    })
    .catch(() => {
      render({ history: { total: 0, items: [] } });
    });
} else {
  render({ history: { total: 0, items: [] } });
}
