'use strict';

/**
 * Standalone development bridge.
 *
 * Runs the same `src/api-bridge.js` server used inside the Orange Fuji app,
 * but with handlers backed by native macOS tools (`screencapture`, `osascript`).
 * This lets you exercise the full MCP -> HTTP bridge -> capture chain without
 * launching the Electron app or granting it screen-recording permission.
 *
 * On non-macOS platforms the capture handler reports a clear error instead.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const { createApiBridge } = require('../src/api-bridge');

const STATE_DIR = path.join(os.homedir(), '.orangefuji-demo');
const SETTINGS_FILE = path.join(STATE_DIR, 'settings.json');
const DEFAULT_SETTINGS = {
  defaultSavePath: path.join(os.homedir(), 'Downloads'),
  hideDesktopIcons: true,
  captureOrangeFuji: false,
  apiEnabled: true,
};

function readSettings() {
  try {
    return { ...DEFAULT_SETTINGS, ...JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8')) };
  } catch (_) {
    return { ...DEFAULT_SETTINGS };
  }
}

function writeSettings(patch) {
  const next = { ...readSettings(), ...(patch || {}) };
  fs.mkdirSync(STATE_DIR, { recursive: true });
  fs.writeFileSync(SETTINGS_FILE, JSON.stringify(next, null, 2));
  return next;
}

function primaryDisplay() {
  try {
    const out = execFileSync('osascript', ['-e', 'tell application "Finder" to get bounds of window of desktop'], {
      encoding: 'utf8',
    });
    const [x, y, width, height] = out.trim().split(',').map((n) => Number(n.trim()));
    return { id: 1, label: 'Primary', primary: true, bounds: { x, y, width, height }, scaleFactor: 1, rotation: 0 };
  } catch (_) {
    return { id: 1, label: 'Primary', primary: true, bounds: { x: 0, y: 0, width: 1440, height: 900 }, scaleFactor: 1, rotation: 0 };
  }
}

function pngSize(buffer) {
  if (buffer.length > 24 && buffer.toString('ascii', 1, 4) === 'PNG') {
    return { width: buffer.readUInt32BE(16), height: buffer.readUInt32BE(20) };
  }
  return { width: 0, height: 0 };
}

function macCapture(rect) {
  const tmp = path.join(os.tmpdir(), `orangefuji-demo-${Date.now()}-${Math.random().toString(36).slice(2)}.png`);
  const args = ['-x', '-t', 'png'];
  if (rect) args.push('-R', `${Math.round(rect.x)},${Math.round(rect.y)},${Math.round(rect.width)},${Math.round(rect.height)}`);
  args.push(tmp);
  try {
    execFileSync('/usr/sbin/screencapture', args);
    const buffer = fs.readFileSync(tmp);
    return buffer;
  } finally {
    fs.rmSync(tmp, { force: true });
  }
}

function captureHandler(params) {
  if (process.platform !== 'darwin') {
    return { success: false, error: 'Standalone dev bridge only supports macOS captures. Use the app on other platforms.' };
  }
  const options = params.options || {};
  const mode = params.mode === 'region' ? 'region' : 'fullscreen';
  let buffer;
  try {
    buffer = macCapture(mode === 'region' ? params.rect : null);
  } catch (error) {
    return { success: false, error: error.message };
  }

  const size = pngSize(buffer);
  const dataUrl = `data:image/png;base64,${buffer.toString('base64')}`;
  const result = { success: true, mode, dataUrl, width: size.width, height: size.height };

  if (options.save) {
    const dir = readSettings().defaultSavePath || os.homedir();
    const filename = options.filename || `orange-fuji-mcp-${mode}-${Date.now()}.png`;
    const outputPath = path.join(dir, String(filename).replace(/[\\/]/g, '_'));
    fs.writeFileSync(outputPath, buffer);
    result.savedPath = outputPath;
  }
  if (options.copy) {
    try {
      const tmp = path.join(os.tmpdir(), `orangefuji-clip-${Date.now()}.png`);
      fs.writeFileSync(tmp, buffer);
      execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(tmp)}) as «class PNGf»)`]);
      fs.rmSync(tmp, { force: true });
      result.copied = true;
    } catch (error) {
      result.copyError = error.message;
    }
  }
  return result;
}

async function startDevBridge(options = {}) {
  const token = options.token || `dev-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
  const bridge = createApiBridge({
    token,
    appName: 'Orange Fuji (dev bridge)',
    version: 'dev',
    handlers: {
      listDisplays: () => [primaryDisplay()],
      getSettings: () => readSettings(),
      updateSettings: (patch) => writeSettings(patch),
      capture: (params) => captureHandler(params),
      copyToClipboard: (dataUrl) => {
        const buffer = Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64');
        const tmp = path.join(os.tmpdir(), `orangefuji-clip-${Date.now()}.png`);
        fs.writeFileSync(tmp, buffer);
        execFileSync('osascript', ['-e', `set the clipboard to (read (POSIX file ${JSON.stringify(tmp)}) as «class PNGf»)`]);
        fs.rmSync(tmp, { force: true });
        return { success: true };
      },
      saveFile: (dataUrl, filename) => {
        const dir = readSettings().defaultSavePath || os.homedir();
        const outputPath = path.join(dir, String(filename || `orange-fuji-mcp-${Date.now()}.png`).replace(/[\\/]/g, '_'));
        fs.writeFileSync(outputPath, Buffer.from(String(dataUrl).replace(/^data:image\/\w+;base64,/, ''), 'base64'));
        return { success: true, path: outputPath };
      },
    },
  });

  const address = await bridge.listen({ host: '127.0.0.1', port: options.port || 0 });
  return {
    url: `http://${address.host}:${address.port}`,
    token,
    close: () => bridge.close(),
  };
}

module.exports = { startDevBridge };

if (require.main === module) {
  startDevBridge()
    .then((info) => {
      process.stdout.write(`${JSON.stringify({ url: info.url, token: info.token }, null, 2)}\n`);
      process.stderr.write('[dev-bridge] listening. Ctrl+C to stop.\n');
    })
    .catch((error) => {
      process.stderr.write(`[dev-bridge] failed: ${error.message}\n`);
      process.exit(1);
    });
}
