/**
 * Native macOS screen recorder controller.
 *
 * Drives the ScreenCaptureKit helper binary (src/bin/orange-fuji-recorder),
 * which records at the display's native physical pixel resolution — the
 * quality path Chromium's getDisplayMedia cannot reach (it caps desktop
 * frames at the logical/scaled UI resolution on Retina Macs).
 *
 * The helper speaks a line-delimited JSON event protocol on stdout:
 *   {"event":"ready","width":W,"height":H,"fps":F,"audio":bool}
 *   {"event":"started"}
 *   {"event":"stopped","file":"...","duration":S}
 *   {"event":"error","message":"..."}
 * and finalizes the MP4 cleanly when it receives SIGTERM/SIGINT.
 *
 * Platform note: darwin only. Windows/Linux keep the MediaRecorder pipeline.
 */

const path = require('path');
const readline = require('readline');
const { spawn } = require('child_process');
const { app } = require('electron');
const { resolveBundledBinary } = require('./media-binaries');

const START_TIMEOUT_MS = 15000;
const STOP_TIMEOUT_MS = 10000;

let activeProcess = null;
let activeSession = null; // { outPath, resolveStopped }

function isSupported() {
  if (process.platform !== 'darwin') return false;
  try {
    resolveBundledBinary('orange-fuji-recorder');
    return true;
  } catch (_) {
    return false;
  }
}

function tempRecordingPath() {
  const name = `pico-native-recording-${Date.now()}-${Math.random().toString(36).slice(2)}.mp4`;
  return path.join(app.getPath('temp'), name);
}

function regionIsValid(region) {
  return Boolean(region)
    && [region.x, region.y, region.width, region.height].every((v) => Number.isFinite(v))
    && region.width > 0
    && region.height > 0;
}

function attachEventReader(child, onEvent) {
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    try {
      const parsed = JSON.parse(line);
      if (parsed && typeof parsed.event === 'string') onEvent(parsed);
    } catch (_) { /* non-JSON stdout noise */ }
  });
  return rl;
}

function startRecording(options = {}) {
  if (activeProcess) {
    return Promise.reject(new Error('A native screen recording is already in progress'));
  }

  let binary;
  try {
    binary = resolveBundledBinary('orange-fuji-recorder');
  } catch (error) {
    return Promise.reject(error);
  }

  const outPath = typeof options.outPath === 'string' && options.outPath
    ? options.outPath
    : tempRecordingPath();
  const args = ['--out', outPath, '--fps', String(Number.isFinite(options.fps) ? options.fps : 60)];
  if (Number.isFinite(options.displayId)) args.push('--display', String(options.displayId));
  if (options.muted === true) args.push('--no-audio');
  if (Number.isFinite(options.bitrate) && options.bitrate > 0) args.push('--bitrate', String(options.bitrate));
  if (regionIsValid(options.region)) {
    args.push('--region', [
      Math.round(options.region.x),
      Math.round(options.region.y),
      Math.round(options.region.width),
      Math.round(options.region.height),
    ].join(','));
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let readyMeta = null;

    const child = spawn(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stderrTail = '';
    child.stderr.on('data', (chunk) => {
      stderrTail = `${stderrTail}${chunk}`.slice(-2000);
    });

    const failStart = (message) => {
      if (settled) return;
      settled = true;
      clearTimeout(startTimer);
      child.kill('SIGKILL');
      reject(new Error(`${message}${stderrTail ? `\n${stderrTail}` : ''}`));
    };

    const startTimer = setTimeout(() => failStart('Native recorder did not start in time'), START_TIMEOUT_MS);

    const rl = attachEventReader(child, (event) => {
      switch (event.event) {
        case 'ready':
          readyMeta = {
            width: Number(event.width) || 0,
            height: Number(event.height) || 0,
            fps: Number(event.fps) || 0,
            audio: Boolean(event.audio),
          };
          break;
        case 'started':
          if (settled) break;
          settled = true;
          clearTimeout(startTimer);
          activeProcess = child;
          activeSession = { outPath, resolveStopped: null };
          resolve({ success: true, outPath, ...readyMeta });
          break;
        case 'stopped': {
          const result = { file: event.file || outPath, duration: Number(event.duration) || 0 };
          activeSession?.resolveStopped?.(result);
          break;
        }
        case 'error':
          failStart(`Native recorder error: ${event.message || 'unknown'}`);
          break;
        default:
          break;
      }
    });

    child.on('exit', (code) => {
      clearTimeout(startTimer);
      rl.close();
      if (!settled) {
        settled = true;
        reject(new Error(`Native recorder exited early (code ${code})${stderrTail ? `\n${stderrTail}` : ''}`));
        return;
      }
      if (activeSession?.resolveStopped) {
        // SIGKILL fallback or crash after start: no clean finalize happened.
        activeSession.resolveStopped({ file: activeSession.outPath, duration: null, exitCode: code });
      }
    });
    child.on('error', (error) => failStart(`Failed to spawn native recorder: ${error.message}`));
  });
}

function stopRecording() {
  return new Promise((resolve, reject) => {
    const child = activeProcess;
    if (!child) {
      reject(new Error('No native screen recording is in progress'));
      return;
    }
    const session = activeSession;

    let settled = false;
    session.resolveStopped = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(forceKillTimer);
      activeProcess = null;
      activeSession = null;
      resolve(result);
    };

    const forceKillTimer = setTimeout(() => {
      // Last resort: the MP4 may be unfinalized. Surface what we know.
      if (settled) return;
      settled = true;
      activeProcess = null;
      activeSession = null;
      try { child.kill('SIGKILL'); } catch (_) { /* already gone */ }
      resolve({ file: session.outPath, duration: null, forced: true });
    }, STOP_TIMEOUT_MS);

    try {
      child.kill('SIGTERM');
    } catch (error) {
      clearTimeout(forceKillTimer);
      reject(error);
    }
  });
}

function isActive() {
  return Boolean(activeProcess);
}

module.exports = { isSupported, startRecording, stopRecording, isActive };
