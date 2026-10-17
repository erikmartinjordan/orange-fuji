'use strict';

/**
 * Discovers the running Orange Fuji local API bridge and calls it.
 *
 * Resolution order:
 *   1. ORANGE_FUJI_API_URL + ORANGE_FUJI_API_TOKEN env vars
 *   2. ORANGE_FUJI_ENDPOINT_FILE (explicit path to api-endpoint.json)
 *   3. The default endpoint file inside the app's userData directory
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const ENDPOINT_FILE = 'api-endpoint.json';
const APP_DIRS = ['pico', 'Orange Fuji', 'orangefuji'];

function endpointFileCandidates() {
  const candidates = [];
  const home = os.homedir();

  if (process.platform === 'darwin') {
    for (const dir of APP_DIRS) {
      candidates.push(path.join(home, 'Library', 'Application Support', dir, ENDPOINT_FILE));
    }
  } else if (process.platform === 'win32') {
    const appData = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    for (const dir of APP_DIRS) candidates.push(path.join(appData, dir, ENDPOINT_FILE));
  } else {
    const configHome = process.env.XDG_CONFIG_HOME || path.join(home, '.config');
    for (const dir of APP_DIRS) candidates.push(path.join(configHome, dir, ENDPOINT_FILE));
  }

  return candidates;
}

function readEndpointFile(filePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (parsed && parsed.url && parsed.token) return { url: parsed.url, token: parsed.token };
  } catch (_) {}
  return null;
}

function resolveEndpoint() {
  if (process.env.ORANGE_FUJI_API_URL && process.env.ORANGE_FUJI_API_TOKEN) {
    return { url: process.env.ORANGE_FUJI_API_URL, token: process.env.ORANGE_FUJI_API_TOKEN };
  }

  const explicit = process.env.ORANGE_FUJI_ENDPOINT_FILE;
  const files = explicit ? [explicit, ...endpointFileCandidates()] : endpointFileCandidates();
  for (const file of files) {
    const endpoint = readEndpointFile(file);
    if (endpoint) return { ...endpoint, source: file };
  }

  const error = new Error(
    'Orange Fuji API is not reachable. Open the app, enable "AI & MCP access" in Settings, then retry.'
  );
  error.code = 'NO_ENDPOINT';
  throw error;
}

function createClient() {
  return {
    async call(route, { method = 'GET', body } = {}) {
      const endpoint = resolveEndpoint();
      let response;
      try {
        response = await fetch(`${endpoint.url}${route}`, {
          method,
          headers: {
            authorization: `Bearer ${endpoint.token}`,
            'content-type': 'application/json',
          },
          body: body === undefined ? undefined : JSON.stringify(body),
        });
      } catch (error) {
        throw new Error(`Could not reach Orange Fuji at ${endpoint.url}: ${error.message}`);
      }

      const text = await response.text();
      const payload = text ? JSON.parse(text) : {};
      if (!response.ok) {
        throw new Error(payload.error || `Orange Fuji API returned ${response.status}`);
      }
      return payload;
    },
  };
}

module.exports = { createClient, resolveEndpoint, endpointFileCandidates };
