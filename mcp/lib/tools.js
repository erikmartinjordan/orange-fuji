'use strict';

/**
 * MCP tool definitions + execution. Each tool maps to one call on the
 * Orange Fuji local API bridge.
 */

const TOOLS = [
  {
    name: 'get_status',
    description: 'Check whether the Orange Fuji local API is running and return the app version.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'list_displays',
    description: 'List the connected displays with their bounds and scale factor.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'get_settings',
    description: 'Read the current Orange Fuji settings.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  },
  {
    name: 'update_settings',
    description: 'Update one or more Orange Fuji settings (defaultSavePath, hideDesktopIcons, captureOrangeFuji, apiEnabled, ...).',
    inputSchema: {
      type: 'object',
      properties: { patch: { type: 'object', description: 'Settings keys to merge.' } },
      required: ['patch'],
      additionalProperties: false,
    },
  },
  {
    name: 'capture_fullscreen',
    description: 'Capture the primary display. Optionally save to disk and/or copy to the clipboard.',
    inputSchema: {
      type: 'object',
      properties: {
        save: { type: 'boolean', description: 'Save the PNG to the default save folder.' },
        copy: { type: 'boolean', description: 'Copy the image to the clipboard.' },
        filename: { type: 'string', description: 'Filename to use when saving.' },
        include_image: { type: 'boolean', description: 'Return the image so the model can see it. Default true.' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'capture_region',
    description: 'Capture a rectangular region of the primary display, in screen coordinates.',
    inputSchema: {
      type: 'object',
      properties: {
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number' },
        height: { type: 'number' },
        save: { type: 'boolean' },
        copy: { type: 'boolean' },
        filename: { type: 'string' },
        include_image: { type: 'boolean' },
      },
      required: ['x', 'y', 'width', 'height'],
      additionalProperties: false,
    },
  },
  {
    name: 'copy_image_to_clipboard',
    description: 'Copy a base64 data URL image to the clipboard.',
    inputSchema: {
      type: 'object',
      properties: { dataUrl: { type: 'string' } },
      required: ['dataUrl'],
      additionalProperties: false,
    },
  },
  {
    name: 'save_image',
    description: 'Save a base64 data URL image to disk.',
    inputSchema: {
      type: 'object',
      properties: { dataUrl: { type: 'string' }, filename: { type: 'string' } },
      required: ['dataUrl'],
      additionalProperties: false,
    },
  },
];

function textResult(text) {
  return { content: [{ type: 'text', text }] };
}

function captureResult(result, includeImage) {
  if (!result || result.success === false) {
    return { content: [{ type: 'text', text: `Capture failed: ${result?.error || 'unknown error'}` }], isError: true };
  }

  const lines = [`Captured ${result.mode} (${result.width}x${result.height}).`];
  if (result.savedPath) lines.push(`Saved to ${result.savedPath}.`);
  if (result.copyError) lines.push(`Clipboard copy failed: ${result.copyError}`);
  if (result.copied) lines.push('Copied to clipboard.');
  if (result.saveError) lines.push(`Save failed: ${result.saveError}`);

  const content = [{ type: 'text', text: lines.join(' ') }];
  if (includeImage !== false && result.dataUrl) {
    const base64 = String(result.dataUrl).replace(/^data:image\/\w+;base64,/, '');
    content.push({ type: 'image', data: base64, mimeType: 'image/png' });
  }
  return { content };
}

async function runTool(name, args, client) {
  const a = args || {};
  switch (name) {
    case 'get_status': {
      const info = await client.call('/health');
      return textResult(`${info.app} API v${info.apiVersion} is running (app ${info.version}).`);
    }
    case 'list_displays': {
      const { displays } = await client.call('/displays');
      const text = displays
        .map((d) => `#${d.id}${d.primary ? ' (primary)' : ''} ${d.bounds.width}x${d.bounds.height} @${d.scaleFactor}x`)
        .join('\n');
      return textResult(text || 'No displays reported.');
    }
    case 'get_settings': {
      const { settings } = await client.call('/settings');
      return textResult(JSON.stringify(settings, null, 2));
    }
    case 'update_settings': {
      if (!a.patch || typeof a.patch !== 'object') {
        return { content: [{ type: 'text', text: 'update_settings requires a "patch" object.' }], isError: true };
      }
      const { settings } = await client.call('/settings', { method: 'POST', body: { patch: a.patch } });
      return textResult(`Settings updated.\n${JSON.stringify(settings, null, 2)}`);
    }
    case 'capture_fullscreen': {
      const result = await client.call('/capture/fullscreen', {
        method: 'POST',
        body: { save: a.save, copy: a.copy, filename: a.filename },
      });
      return captureResult(result, a.include_image);
    }
    case 'capture_region': {
      const result = await client.call('/capture/region', {
        method: 'POST',
        body: { x: a.x, y: a.y, width: a.width, height: a.height, save: a.save, copy: a.copy, filename: a.filename },
      });
      return captureResult(result, a.include_image);
    }
    case 'copy_image_to_clipboard': {
      await client.call('/clipboard', { method: 'POST', body: { dataUrl: a.dataUrl } });
      return textResult('Image copied to clipboard.');
    }
    case 'save_image': {
      const result = await client.call('/save', { method: 'POST', body: { dataUrl: a.dataUrl, filename: a.filename } });
      return textResult(`Saved to ${result.path}.`);
    }
    default: {
      return { content: [{ type: 'text', text: `Unknown tool: ${name}` }], isError: true };
    }
  }
}

module.exports = { TOOLS, runTool };
