/**
 * Orange Fuji - Onboarding (Permissions)
 * Blocking first-run flow: Grant -> Enable -> Restart.
 * Real-time monitoring of the Screen Recording toggle.
 */

const els = {
  card: document.getElementById('ob-card'),
  stage: document.getElementById('ob-stage'),
  title: document.getElementById('ob-title'),
  copy: document.getElementById('ob-copy'),
  statusText: document.getElementById('ob-status-text'),
  dot: document.getElementById('ob-dot'),
  action: document.getElementById('ob-action'),
  hint: document.getElementById('ob-hint'),
  skip: document.getElementById('ob-skip'),
  steps: Array.from(document.querySelectorAll('.ob-step')),
};

let pollTimer = null;
let state = 'checking';          // checking | ask | enable | granted
let visitedSettings = false;
let actionBusy = false;

function setSteps(active) {
  const order = ['grant', 'enable', 'relaunch'];
  els.steps.forEach((li, i) => {
    li.classList.toggle('done', order.indexOf(active) > i);
    li.classList.toggle('active', li.dataset.step === active);
  });
}

function render(next) {
  state = next;
  els.card.className = 'ob-card';
  els.stage.className = 'ob-stage';
  els.dot.className = 'ob-status-dot';
  els.action.disabled = false;
  els.skip.hidden = false;
  els.hint.hidden = false;

  if (state === 'checking') {
    setSteps('grant');
    els.card.classList.add('is-checking');
    els.stage.classList.add('st-wait');
    els.dot.classList.add('pulse');
    els.title.textContent = 'Checking permissions…';
    els.copy.textContent = 'One moment while we look at your macOS settings.';
    els.statusText.textContent = 'Reading system state';
    els.action.textContent = '…';
    els.action.disabled = true;
    els.hint.hidden = true;
    return;
  }

  if (state === 'ask') {
    setSteps('grant');
    els.stage.classList.add('st-ask');
    els.dot.classList.add('amber');
    els.title.textContent = 'Allow screen access';
    els.copy.textContent = 'macOS requires one approval before Orange Fuji can capture or record your screen.';
    els.statusText.textContent = 'Waiting for you';
    els.action.textContent = 'Grant Access';
    els.hint.textContent = 'A macOS dialog will appear — nothing is shared until you allow it.';
    return;
  }

  if (state === 'enable') {
    setSteps('enable');
    els.stage.classList.add('st-wait');
    els.dot.classList.add('amber', 'pulse');
    els.title.textContent = 'Enable Orange Fuji';
    els.copy.innerHTML = 'In <strong>System Settings → Privacy &amp; Security → Screen Recording</strong>, turn on <strong>Orange Fuji</strong>. We are watching for the change — this panel updates by itself.';
    els.statusText.textContent = 'Monitoring Settings…';
    els.action.textContent = 'Open System Settings';
    els.hint.textContent = 'Leave this window open. As soon as you flip the switch, we continue automatically.';
    return;
  }

  // granted
  setSteps('relaunch');
  els.card.classList.add('is-granted');
  els.stage.classList.add('st-done');
  els.dot.classList.add('green');
  els.title.textContent = 'All set!';
  els.copy.textContent = 'Permission granted. One last restart and you are ready to capture.';
  els.statusText.textContent = 'Permission active ✓';
  els.action.textContent = 'Restart Now';
  els.skip.hidden = true;
  els.hint.textContent = 'The app reopens by itself in a second.';
}

async function refresh() {
  if (actionBusy) return;
  try {
    const r = await window.pico.getScreenRecordingStatus();
    if (r.canCapture || r.status === 'granted') {
      if (state !== 'granted') render('granted');
      return;
    }
    if (r.status === 'denied') {
      if (state !== 'enable' && state !== 'granted') render('enable');
      return;
    }
    if (state !== 'ask' && state !== 'enable' && state !== 'granted') render('ask');
  } catch (_) { /* keep current view */ }
}

function startPolling() {
  if (pollTimer) clearInterval(pollTimer);
  pollTimer = setInterval(refresh, 900);
}

els.action.addEventListener('click', async () => {
  if (actionBusy) return;

  if (state === 'granted') {
    actionBusy = true;
    els.action.disabled = true;
    els.action.textContent = 'Restarting…';
    try {
      await window.pico.notifyAndRelaunch();
    } catch (_) {
      try { await window.pico.relaunchApp(); } catch (_) {}
    }
    return;
  }

  if (state === 'ask') {
    // Fire the single native prompt, user-initiated.
    actionBusy = true;
    els.action.disabled = true;
    els.action.textContent = 'Waiting for macOS…';
    try {
      const r = await window.pico.requestScreenRecordingPermission();
      if (r.granted || r.canCapture) render('granted');
      else render('enable');           // denied → guide to Settings
    } catch (_) {
      render('enable');
    } finally {
      actionBusy = false;
    }
    startPolling();
    return;
  }

  if (state === 'enable') {
    els.action.disabled = true;
    els.action.textContent = 'Opening…';
    visitedSettings = true;
    try { await window.pico.openScreenRecordingSettings(); } catch (_) {}
    setTimeout(() => {
      els.action.disabled = false;
      els.action.textContent = 'Open System Settings';
    }, 900);
  }
});

els.skip.addEventListener('click', () => {
  if (pollTimer) clearInterval(pollTimer);
  window.pico.closeOnboarding?.();
});

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && state !== 'granted') els.skip.click();
});

// Real-time: react the moment the user returns from System Settings.
window.addEventListener('focus', refresh);
document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });

render('checking');
refresh().then(() => {
  if (state === 'checking') render('ask');
  startPolling();
});
