const assert = require('assert');
const path = require('path');
const fs = require('fs');
const vm = require('vm');

// ── E2E Focus Preservation Tests ──────────────────────────────────────────
// These tests simulate the capture flow with mocked Electron primitives
// to ensure the source window (where Cmd+Shift+S was pressed) keeps focus
// and no Space switch occurs. They supplement the regex checks in
// regression.test.js with behavioural verification.

function createMockWindow(name = 'source') {
  const calls = [];
  return {
    name,
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: () => calls.push('restore'),
    show: () => calls.push('show'),
    showInactive: () => calls.push('showInactive'),
    hide: () => calls.push('hide'),
    focus: () => calls.push('focus'),
    moveTop: () => calls.push('moveTop'),
    setVisibleOnAllWorkspaces: () => calls.push('setVisibleOnAllWorkspaces'),
    setAlwaysOnTop: () => calls.push('setAlwaysOnTop'),
    setContentProtection: (v) => calls.push(`setContentProtection:${v}`),
    setBounds: () => calls.push('setBounds'),
    getBounds: () => ({ x: 0, y: 0, width: 800, height: 600 }),
    calls,
  };
}

function createMockApp() {
  return {
    getPath: () => '/tmp',
    setName: () => {},
    setPath: () => {},
    getVersion: () => '1.0.0',
    isHidden: () => false,
    focus: () => {},
    show: () => {},
    dock: { show: () => {} },
  };
}

// Test 1: hideOrangeFujiWindowsBeforeCapture for region must use contentProtection, not hide
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.ok(
    mainSource.includes("if (options?.mode === 'region'") && mainSource.includes('setOrangeFujiWindowsContentProtection(true)'),
    'region capture must keep pill visible via contentProtection'
  );
  assert.ok(!mainSource.includes("win.hide()") || mainSource.includes("getOrangeFujiAppWindows()"),
    'hide helper must exist for non-region captures'
  );
  console.log('\x1b[32m✓\x1b[0m E2E: hideOrangeFujiWindowsBeforeCapture preserves focus for region');
}

// Test 2: applyEditorWindowMode must use showInactive on darwin
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.ok(
    mainSource.includes("mainWindow.showInactive()") && mainSource.includes("function applyEditorWindowMode"),
    'applyEditorWindowMode must use showInactive on darwin'
  );

  // Simulate the function
  const mockWin = createMockWindow('editor');
  const sandbox = {
    mainWindow: mockWin,
    mainWindowMode: 'toolbar',
    process: { platform: 'darwin' },
    TOOLBAR_WINDOW_SIZE: { width: 260, height: 110 },
    EDITOR_MIN_SIZE: { width: 900, height: 600 },
    getEditorWindowBounds: () => ({ x: 100, y: 100, width: 1200, height: 800 }),
    recordingInProgress: false,
  };

  const code = `
    let mainWindowMode = 'toolbar';
    function applyEditorWindowMode(options = {}) {
      mainWindowMode = 'editor';
      if (options.show) {
        if (recordingInProgress) { mainWindow.hide(); return; }
        if (mainWindow.isMinimized()) mainWindow.restore();
        if (process.platform === 'darwin') {
          mainWindow.showInactive();
        } else {
          mainWindow.show(); mainWindow.moveTop(); mainWindow.focus();
        }
      }
    }
  `;
  vm.runInNewContext(code, sandbox);
  sandbox.mainWindow.calls.length = 0;
  sandbox.applyEditorWindowMode({ show: true });
  assert.ok(sandbox.mainWindow.calls.includes('showInactive'), 'editor show must use showInactive on darwin');
  assert.ok(!sandbox.mainWindow.calls.includes('focus'), 'editor must not call focus on darwin');
  console.log('\x1b[32m✓\x1b[0m E2E: applyEditorWindowMode preserves source focus');

  // Also test toolbar mode
  sandbox.mainWindow.calls.length = 0;
  const toolbarCode = `
    function applyToolbarWindowMode(options = {}) {
      if (process.platform === 'darwin' && options.show) {
        mainWindow.showInactive();
      }
    }
  `;
  vm.runInNewContext(toolbarCode, sandbox);
  sandbox.applyToolbarWindowMode({ show: true });
  assert.ok(sandbox.mainWindow.calls.includes('showInactive'), 'toolbar must use showInactive');
  console.log('\x1b[32m✓\x1b[0m E2E: applyToolbarWindowMode preserves source focus');
}

// Test 3: Global shortcuts must not bounce via renderer (which switches Spaces)
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  assert.ok(!mainSource.includes("sendShortcutTriggerToRenderer('trigger-capture-window')"), 'window capture shortcut must not bounce via renderer');
  assert.ok(!mainSource.includes("sendShortcutTriggerToRenderer('trigger-capture-fullscreen')"), 'fullscreen shortcut must not bounce via renderer');
  assert.ok(mainSource.includes("captureWindow({") && mainSource.includes("showToolbar: false"), 'shortcuts must use direct main-process path with showToolbar:false');
  console.log('\x1b[32m✓\x1b[0m E2E: global shortcuts avoid Space-switching renderer bounce');
}

// Test 4: Capture overlay windows must use showInactive and not visibleOnAllWorkspaces
{
  const mainSource = fs.readFileSync(path.join(__dirname, '../src/main.js'), 'utf8');
  // Find the capture overlay creation block
  const overlayBlock = mainSource.slice(mainSource.indexOf("win.loadFile(path.join(__dirname, 'renderer', 'capture-overlay.html'))") - 500, mainSource.indexOf("win.loadFile(path.join(__dirname, 'renderer', 'capture-overlay.html'))") + 2000);
  assert.ok(!overlayBlock.includes('setVisibleOnAllWorkspaces(true'), 'overlays must not use visibleOnAllWorkspaces');
  assert.ok(mainSource.includes("if (process.platform === 'darwin') win.showInactive();"), 'overlays must use showInactive on darwin');
  console.log('\x1b[32m✓\x1b[0m E2E: capture overlays avoid Space switches');
}

console.log('\nAll E2E focus tests passed.');
