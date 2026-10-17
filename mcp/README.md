# orangefuji-mcp

An MCP (Model Context Protocol) server that lets an AI assistant drive
[Orange Fuji](../) through a local, token-protected HTTP bridge.

```
AI client ──stdio──▶ orangefuji-mcp ──HTTP 127.0.0.1 + token──▶ Orange Fuji (Electron main)
```

No third-party dependencies: the MCP protocol is implemented directly over
stdio and the bridge client uses Node's built-in `fetch`.

## Requirements

- Node.js 18 or newer.
- Orange Fuji running with **Settings → General → AI & MCP access** enabled.

When the toggle is on, the app writes an endpoint file with the URL and token to
its userData folder (`~/Library/Application Support/pico/api-endpoint.json` on
macOS). The MCP server discovers it automatically.

## Try it

```bash
# Full end-to-end demo without launching the app (uses macOS `screencapture`)
node demo.js

# Talk to a running Orange Fuji app
node demo.js --app

# Run a single tool
node demo.js --app --tool capture_region --args '{"x":0,"y":0,"width":400,"height":300,"save":true}'
```

`demo.js` spawns the real `server.js` and speaks JSON-RPC to it over stdio,
exactly like an AI client would.

## Tools

| Tool | Description |
| --- | --- |
| `get_status` | Health check, app version |
| `list_displays` | Displays with bounds and scale factor |
| `get_settings` | Read current settings |
| `update_settings` | Merge a settings patch |
| `capture_fullscreen` | Capture the primary display (`save`, `copy`, `include_image`) |
| `capture_region` | Capture `{x,y,width,height}` (`save`, `copy`, `include_image`) |
| `copy_image_to_clipboard` | Copy a data URL image to the clipboard |
| `save_image` | Save a data URL image to disk |

## Configure your AI client

### opencode (`opencode.json`)

```json
{
  "mcp": {
    "orange-fuji": {
      "type": "local",
      "command": ["node", "/absolute/path/to/orange-fuji/mcp/server.js"],
      "enabled": true
    }
  }
}
```

### Claude Desktop (`claude_desktop_config.json`)

```json
{
  "mcpServers": {
    "orange-fuji": {
      "command": "node",
      "args": ["/absolute/path/to/orange-fuji/mcp/server.js"]
    }
  }
}
```

Override discovery with `ORANGE_FUJI_API_URL` and `ORANGE_FUJI_API_TOKEN`, or
point at a specific endpoint file with `ORANGE_FUJI_ENDPOINT_FILE`.

## Security

- The bridge binds to `127.0.0.1` only and requires a bearer token.
- It is off by default; enable or disable it any time in the app's Settings.
- The token can be regenerated from the same settings panel.
- Everything (captures, files) stays on your machine.
