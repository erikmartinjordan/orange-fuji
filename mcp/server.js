#!/usr/bin/env node
'use strict';

/**
 * Orange Fuji MCP server (stdio).
 *
 * A dependency-free implementation of the Model Context Protocol over stdio:
 * it answers `initialize`, `tools/list` and `tools/call`, and forwards every
 * tool invocation to the running Orange Fuji app through the local API bridge.
 */

const readline = require('readline');
const { createClient } = require('./lib/bridge-client');
const { TOOLS, runTool } = require('./lib/tools');

const SERVER_INFO = { name: 'orangefuji-mcp', version: '0.1.0' };
const DEFAULT_PROTOCOL_VERSION = '2024-11-05';

const client = createClient();

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

async function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || DEFAULT_PROTOCOL_VERSION,
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return;
  }

  if (method === 'notifications/initialized' || method === 'initialized' || method === 'notifications/cancelled') {
    return;
  }

  if (method === 'ping') {
    reply(id, {});
    return;
  }

  if (method === 'tools/list') {
    reply(id, { tools: TOOLS });
    return;
  }

  if (method === 'tools/call') {
    const name = params?.name;
    const args = params?.arguments || {};
    try {
      reply(id, await runTool(name, args, client));
    } catch (error) {
      reply(id, {
        content: [{ type: 'text', text: `Error: ${error.message}` }],
        isError: true,
      });
    }
    return;
  }

  if (id !== undefined && id !== null) {
    replyError(id, -32601, `Method not found: ${method}`);
  }
}

const rl = readline.createInterface({ input: process.stdin });
rl.on('line', (line) => {
  const text = line.trim();
  if (!text) return;
  let message;
  try {
    message = JSON.parse(text);
  } catch (_) {
    return;
  }
  if (Array.isArray(message)) {
    for (const item of message) void handle(item);
    return;
  }
  handle(message).catch((error) => {
    if (message && message.id !== undefined && message.id !== null) {
      replyError(message.id, -32603, error.message);
    }
  });
});
