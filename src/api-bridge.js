'use strict';

/**
 * Orange Fuji - Local API bridge
 *
 * A tiny, token-guarded HTTP server bound to 127.0.0.1 that exposes a stable
 * JSON surface the `orangefuji-mcp` server can call. It is intentionally
 * dependency-free and decoupled from Electron: every capability is provided by
 * the injected `handlers`, which keeps this module unit-testable in plain Node.
 */

const http = require('http');
const crypto = require('crypto');

const DEFAULT_MAX_BODY_BYTES = 32 * 1024 * 1024;
const API_VERSION = 1;

function safeEqual(a, b) {
  const bufA = Buffer.from(String(a || ''));
  const bufB = Buffer.from(String(b || ''));
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  });
  res.end(body);
}

function readJsonBody(req, maxBodyBytes) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > maxBodyBytes) {
        reject(Object.assign(new Error('Payload too large'), { statusCode: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8').trim();
      if (!raw) return resolve({});
      try {
        const parsed = JSON.parse(raw);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
          reject(Object.assign(new Error('Body must be a JSON object'), { statusCode: 400 }));
          return;
        }
        resolve(parsed);
      } catch (_) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function requireString(value, field) {
  if (typeof value !== 'string' || !value) {
    throw Object.assign(new Error(`${field} is required`), { statusCode: 400 });
  }
  return value;
}

function normalizeRect(raw) {
  const rect = raw || {};
  const out = {};
  for (const key of ['x', 'y', 'width', 'height']) {
    const value = Number(rect[key]);
    if (!Number.isFinite(value)) {
      throw Object.assign(new Error(`region.${key} must be a number`), { statusCode: 400 });
    }
    out[key] = value;
  }
  if (out.width <= 0 || out.height <= 0) {
    throw Object.assign(new Error('region width and height must be > 0'), { statusCode: 400 });
  }
  return out;
}

function createApiBridge(options = {}) {
  const {
    token,
    handlers = {},
    version = '0.0.0',
    appName = 'Orange Fuji',
    logger = console,
    maxBodyBytes = DEFAULT_MAX_BODY_BYTES,
  } = options;

  if (!token) throw new Error('api-bridge: a token is required');

  const call = async (name, ...args) => {
    const handler = handlers[name];
    if (typeof handler !== 'function') {
      throw Object.assign(new Error(`handler "${name}" is not available`), { statusCode: 501 });
    }
    return handler(...args);
  };

  const server = http.createServer(async (req, res) => {
    const auth = req.headers['authorization'] || '';
    const presented = auth.startsWith('Bearer ') ? auth.slice(7) : '';
    if (!safeEqual(presented, token)) {
      sendJson(res, 401, { error: 'unauthorized' });
      return;
    }

    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const route = url.pathname.replace(/\/+$/, '') || '/';
    const method = req.method || 'GET';

    try {
      if (method === 'GET' && route === '/health') {
        sendJson(res, 200, { ok: true, app: appName, version, apiVersion: API_VERSION });
        return;
      }

      if (method === 'GET' && route === '/displays') {
        sendJson(res, 200, { displays: await call('listDisplays') });
        return;
      }

      if (method === 'GET' && route === '/settings') {
        sendJson(res, 200, { settings: await call('getSettings') });
        return;
      }

      if (method === 'POST' && route === '/settings') {
        const body = await readJsonBody(req, maxBodyBytes);
        const patch = body.patch && typeof body.patch === 'object' ? body.patch : body;
        sendJson(res, 200, { settings: await call('updateSettings', patch) });
        return;
      }

      if (method === 'POST' && route === '/capture/fullscreen') {
        const body = await readJsonBody(req, maxBodyBytes);
        sendJson(res, 200, await call('capture', { mode: 'fullscreen', options: body }));
        return;
      }

      if (method === 'POST' && route === '/capture/region') {
        const body = await readJsonBody(req, maxBodyBytes);
        const rect = normalizeRect(body.region || body);
        sendJson(res, 200, await call('capture', { mode: 'region', rect, options: body }));
        return;
      }

      if (method === 'POST' && route === '/clipboard') {
        const body = await readJsonBody(req, maxBodyBytes);
        const dataUrl = requireString(body.dataUrl, 'dataUrl');
        sendJson(res, 200, await call('copyToClipboard', dataUrl));
        return;
      }

      if (method === 'POST' && route === '/save') {
        const body = await readJsonBody(req, maxBodyBytes);
        const dataUrl = requireString(body.dataUrl, 'dataUrl');
        sendJson(res, 200, await call('saveFile', dataUrl, body.filename));
        return;
      }

      sendJson(res, 404, { error: `no route for ${method} ${route}` });
    } catch (error) {
      const status = error && error.statusCode ? error.statusCode : 500;
      logger.error(`[orange-fuji][api] ${method} ${route} failed:`, error && error.message);
      sendJson(res, status, { error: error && error.message ? error.message : 'internal error' });
    }
  });

  server.on('clientError', (_error, socket) => {
    if (socket.writable) socket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
  });

  return {
    server,
    token,
    listen({ host = '127.0.0.1', port = 0 } = {}) {
      return new Promise((resolve, reject) => {
        const onError = (error) => {
          server.removeListener('listening', onListening);
          reject(error);
        };
        const onListening = () => {
          server.removeListener('error', onError);
          const address = server.address();
          const resolvedHost = address.address;
          resolve({
            host: resolvedHost,
            port: address.port,
            url: `http://${resolvedHost}:${address.port}`,
          });
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen(port, host);
      });
    },
    close() {
      return new Promise((resolve) => {
        if (!server.listening) return resolve();
        server.close(() => resolve());
      });
    },
  };
}

module.exports = { createApiBridge, API_VERSION, DEFAULT_MAX_BODY_BYTES };
