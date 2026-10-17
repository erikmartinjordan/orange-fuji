#!/usr/bin/env node
'use strict';

/**
 * End-to-end demo for the Orange Fuji MCP.
 *
 * Spawns the real MCP server (`server.js`) and talks to it over stdio, exactly
 * like an AI client would. By default it also boots the standalone dev bridge
 * so you can see the whole chain working without launching the app:
 *
 *     node demo.js                 # standalone (macOS capture via screencapture)
 *     node demo.js --app           # talk to a running Orange Fuji app
 *     node demo.js --tool capture_region --args '{"x":0,"y":0,"width":400,"height":300}'
 */

const readline = require('readline');
const { spawn } = require('child_process');
const path = require('path');
const { startDevBridge } = require('./dev-bridge');

function parseArgs(argv) {
  const out = { app: false, tool: null, args: null };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--app') out.app = true;
    else if (token === '--tool') out.tool = argv[++i];
    else if (token === '--args') out.args = argv[++i];
  }
  return out;
}

function createMcpClient(child) {
  let nextId = 1;
  const pending = new Map();
  const rl = readline.createInterface({ input: child.stdout });
  rl.on('line', (line) => {
    const text = line.trim();
    if (!text) return;
    let message;
    try {
      message = JSON.parse(text);
    } catch (_) {
      return;
    }
    if (message.id != null && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id);
      pending.delete(message.id);
      if (message.error) reject(new Error(message.error.message));
      else resolve(message.result);
    }
  });

  return {
    request(method, params) {
      const id = nextId++;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`);
      });
    },
    notify(method, params) {
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method, params })}\n`);
    },
  };
}

function heading(text) {
  process.stdout.write(`\n\x1b[38;5;208m${text}\x1b[0m\n`);
}

function renderResult(result) {
  if (!result || !result.content) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    return;
  }
  for (const block of result.content) {
    if (block.type === 'text') process.stdout.write(`${block.text}\n`);
    else if (block.type === 'image') process.stdout.write(`[image ${block.mimeType}, ${Math.round(block.data.length / 1024)} KB base64]\n`);
    else process.stdout.write(`${JSON.stringify(block)}\n`);
  }
  if (result.isError) process.stdout.write('(tool reported an error)\n');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));

  let devBridge = null;
  const childEnv = { ...process.env };
  if (!options.app) {
    devBridge = await startDevBridge();
    childEnv.ORANGE_FUJI_API_URL = devBridge.url;
    childEnv.ORANGE_FUJI_API_TOKEN = devBridge.token;
    heading(`Started standalone dev bridge at ${devBridge.url}`);
  } else {
    heading('Using a running Orange Fuji app (discovery mode)');
  }

  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: childEnv,
    stdio: ['pipe', 'pipe', 'inherit'],
  });
  const client = createMcpClient(child);

  const shutdown = async () => {
    child.kill('SIGTERM');
    if (devBridge) await devBridge.close().catch(() => {});
  };

  try {
    heading('1) initialize');
    const init = await client.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'orangefuji-demo', version: '1.0.0' },
    });
    client.notify('notifications/initialized');
    process.stdout.write(`server: ${init.serverInfo.name} v${init.serverInfo.version}\n`);

    if (options.tool) {
      const args = options.args ? JSON.parse(options.args) : {};
      heading(`tools/call ${options.tool}`);
      renderResult(await client.request('tools/call', { name: options.tool, arguments: args }));
      return;
    }

    heading('2) tools/list');
    const { tools } = await client.request('tools/list', {});
    for (const tool of tools) process.stdout.write(`  • ${tool.name}\n`);

    heading('3) tools/call get_status');
    renderResult(await client.request('tools/call', { name: 'get_status', arguments: {} }));

    heading('4) tools/call list_displays');
    renderResult(await client.request('tools/call', { name: 'list_displays', arguments: {} }));

    heading('5) tools/call capture_fullscreen { save: true, include_image: false }');
    renderResult(
      await client.request('tools/call', {
        name: 'capture_fullscreen',
        arguments: { save: true, include_image: false },
      })
    );

    process.stdout.write('\n\x1b[32mDemo complete. The MCP server drove a real capture through the local bridge.\x1b[0m\n');
  } catch (error) {
    process.stderr.write(`\nDemo failed: ${error.message}\n`);
    process.exitCode = 1;
  } finally {
    await shutdown();
  }
}

main();
