/**
 * Orange Fuji - Onboarding (Permissions)
 * Polls screen recording status and guides user to System Settings
 */

const els = {
  statusDot: document.getElementById('onboarding-status-dot'),
  statusText: document.getElementById('onboarding-status-text'),
  card: document.getElementById('onboarding-card'),
  openSettings: document.getElementById('onboarding-open-settings'),
  continueBtn: document.getElementById('onboarding-continue'),
  skipBtn: document.getElementById('onboarding-skip'),
};

let pollTimer = null;
let currentStatus = 'checking';
let autoRelaunchScheduled = false;
let hasVisitedSettings = false;

const SETTINGS_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.7"><path d="M12 15a3 3 0 100-6 3 3 0 000 6z"/><path d="M19.4 15a1.65 1.65 0 00.33 1.82l.06.06a2 2 0 11-2.83 2.83l-.06-.06a1.65 1.65 0 00-1.82-.33 1.65 1.65 0 00-1 1.51V21a2 2 0 01-4 0v-.09A1.65 1.65 0 009 19.4a1.65 1.65 0 00-1.82.33l-.06.06a2 2 0 11-2.83-2.83l.06-.06A1.65 1.65 0 004.68 15a1.65 1.65 0 00-1.51-1H3a2 2 0 010-4h.09A1.65 1.65 0 004.68 9a1.65 1.65 0 00-.33-1.82l-.06-.06a2 2 0 012.83-2.83l.06.06A1.65 1.65 0 009 4.68a1.65 1.65 0 001-1.51V3a2 2 0 014 0v.09a1.65 1.65 0 001 1.51 1.65 1.65 0 001.82-.33l.06-.06a2 2 0 012.83 2.83l-.06.06A1.65 1.65 0 0019.4 9a1.65 1.65 0 001.51 1H21a2 2 0 010 4h-.09a1.65 1.65 0 00-1.51 1z"/></svg> ';

function setStatus(status, text) {
  currentStatus = status;
  els.statusText.textContent = text;
  els.statusDot.className = 'onboarding-status-dot';
  els.card.classList.remove('is-granted', 'is-denied', 'is-checking');
  if (status === 'granted') {
    els.statusDot.classList.add('granted');
    els.card.classList.add('is-granted');
    els.continueBtn.disabled = false;
    els.continueBtn.textContent = 'Continue →';
    els.openSettings.innerHTML = SETTINGS_ICON + 'Open System Settings';
    els.openSettings.disabled = true;
    els.openSettings.style.opacity = '0.45';
    // Auto-relaunch when permission is granted via System Settings toggle,
    // so the user doesn't have to manually quit and reopen. Also notify main
    // so the system "Quit and Reopen" dialog (which kills ad-hoc builds
    // without reopening) is handled via before-quit relaunch.
    try { window.pico.notifyPermissionGrantedNeedsRelaunch(); } catch (_) {}
    if (!autoRelaunchScheduled) {
      autoRelaunchScheduled = true;
      els.continueBtn.textContent = 'Restarting…';
      setTimeout(() => {
        window.pico.relaunchApp().catch(() => window.pico.closeOnboarding?.());
      }, 900);
    }
  } else if (status === 'denied') {
    els.statusDot.classList.add('denied');
    els.card.classList.add('is-denied');
    if (hasVisitedSettings) {
      els.continueBtn.disabled = false;
      els.continueBtn.textContent = 'Restart Now →';
      // Override text to guide restart
      els.statusText.textContent = 'Permission denied — enable it in System Settings, then restart';
    } else {
      els.continueBtn.disabled = true;
      els.continueBtn.textContent = 'Continue';
    }
    els.openSettings.innerHTML = SETTINGS_ICON + 'Open System Settings';
    els.openSettings.disabled = false;
    els.openSettings.style.opacity = '1';
  } else if (status === 'not-determined') {
    els.statusDot.classList.add('checking');
    els.card.classList.add('is-checking');
    els.continueBtn.disabled = true;
    els.openSettings.innerHTML = 'Request Permission';
    els.openSettings.disabled = false;
    els.openSettings.style.opacity = '1';
  } else {
    els.statusDot.classList.add('checking');
    els.card.classList.add('is-checking');
    els.continueBtn.disabled = true;
    els.openSettings.innerHTML = SETTINGS_ICON + 'Open System Settings';
    els.openSettings.disabled = false;
    els.openSettings.style.opacity = '1';
  }
}

async function checkPermission() {
  try {
    const result = await window.pico.getScreenRecordingStatus();
    // result: { status: 'granted'|'denied'|'not-determined'|'unknown', canCapture: boolean }
    if (result.canCapture || result.status === 'granted') {
      setStatus('granted', 'Permission granted ✓ — ready to capture');
      return 'granted';
    }
    if (result.status === 'not-determined') {
      setStatus('not-determined', 'Click “Request Permission” to show the macOS prompt');
      return 'not-determined';
    }
    if (result.status === 'denied') {
      setStatus('denied', 'Permission denied — enable it in System Settings');
      return 'denied';
    }
    setStatus('checking', 'Checking permission…');
    return result.status;
  } catch (e) {
    setStatus('checking', 'Unable to check permission');
    return 'unknown';
  }
}

function startPolling() {
  checkPermission();
  if (pollTimer) clearInterval(pollTimer);
  // For not-determined we don't spam polling with native prompts; only poll denied/granted
  pollTimer = setInterval(() => {
    if (currentStatus !== 'not-determined') checkPermission();
  }, 1400);
}

els.openSettings.addEventListener('click', async () => {
  // not-determined → user-initiated native prompt (single prompt)
  if (currentStatus === 'not-determined') {
    els.openSettings.disabled = true;
    els.openSettings.textContent = 'Requesting…';
    try {
      const result = await window.pico.requestScreenRecordingPermission();
      // After native prompt, re-check: will become granted or denied
      if (result.granted) setStatus('granted', 'Permission granted ✓ — ready to capture');
      else if (result.status === 'denied') setStatus('denied', 'Permission denied — enable it in System Settings');
      else checkPermission();
      // Now enable polling for denied/granted transitions
      if (pollTimer) clearInterval(pollTimer);
      pollTimer = setInterval(checkPermission, 1400);
    } catch (_) {
      checkPermission();
    } finally {
      if (currentStatus !== 'granted') {
        els.openSettings.disabled = false;
        if (currentStatus === 'not-determined') els.openSettings.textContent = 'Request Permission';
        else els.openSettings.innerHTML = SETTINGS_ICON + 'Open System Settings';
      }
    }
    return;
  }
  // denied → open System Settings (no native prompt)
  els.openSettings.disabled = true;
  els.openSettings.textContent = 'Opening…';
  hasVisitedSettings = true;
  try { window.pico.notifyPermissionGrantedNeedsRelaunch(); } catch (_) {}
  try {
    await window.pico.openScreenRecordingSettings();
  } catch (_) {}
  // Enable manual restart immediately after visiting Settings, even if
  // polling still reports denied (needs restart to take effect).
  setStatus('denied', 'Permission denied — enable it in System Settings, then restart');
  setTimeout(() => {
    els.openSettings.disabled = false;
    els.openSettings.innerHTML = SETTINGS_ICON + 'Open System Settings';
  }, 900);
});

els.continueBtn.addEventListener('click', async () => {
  if (currentStatus !== 'granted' && !(currentStatus === 'denied' && hasVisitedSettings)) return;
  els.continueBtn.disabled = true;
  els.continueBtn.textContent = 'Restarting…';
  try {
    await window.pico.relaunchApp();
  } catch (e) {
    // fallback: just close
    window.pico.closeOnboarding?.();
  }
});

els.skipBtn.addEventListener('click', () => {
  if (pollTimer) clearInterval(pollTimer);
  window.pico.closeOnboarding?.();
});

// Allow Esc to skip
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') els.skipBtn.click();
});

// Init
startPolling();
// Re-check when window regains focus (user returned from System Settings)
window.addEventListener('focus', checkPermission);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) checkPermission();
});
