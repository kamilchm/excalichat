# Excalichat

Sidecar Excalidraw MCP server for text-mode clients. It runs a browser-based viewer on a random port and exposes MCP tools for incremental diagram updates, multi-diagram sessions, library search/insert, and image exports.

## Install

```bash
npm install -g excalichat
```

## Run (stdio)

```bash
excalichat --stdio
```

## Run (HTTP)

```bash
PORT=3001 excalichat
```

## Viewer URL

The viewer runs on a random port by default and prints a URL like:

```
Excalichat viewer listening on http://localhost:40713
```

You can override with:

```bash
VIEWER_PORT=4000 excalichat --stdio
VIEWER_BASE_URL=https://my-host.example.com excalichat --stdio
```

## MCP tools (short list)

- `create_browser_view` -> returns `{ viewId, url }`
- `get_view_image` -> export URLs or inline image
- `update_browser_view_delta` -> fast partial edits
- `update_browser_view` -> full elements array (use only if needed)
- `list_browser_views` / `set_browser_view_meta` / `close_browser_view`
- `get_view_selection` / `clear_view_selection`
- `list_libraries` / `suggest_libraries`
- `list_library_items`
- `insert_library_item` / `insert_library_by_name` / `insert_library_items`

## Example flow (fast partial update)

1) Call `create_browser_view`
2) Open the returned URL in a browser
3) Call `get_view_image` (ensures the latest render is cached)
4) Call `update_browser_view_delta` with only the changes:

```json
{
  "viewId": "<viewId>",
  "deleteIds": ["old1"],
  "upsertElements": [
    { "id": "box1", "type": "rectangle", "x": 100, "y": 80, "width": 240, "height": 120,
      "backgroundColor": "#a5d8ff", "fillStyle": "solid",
      "label": { "text": "Hello", "fontSize": 24 } }
  ]
}
```

## Example flow (full array)

Use only when you must send a full elements array:

```json
[
  { "type": "restoreCheckpoint", "id": "<checkpointId>" },
  { "type": "delete", "ids": "old1,old2" },
  { "type": "rectangle", "id": "box1", "x": 100, "y": 80, "width": 240, "height": 120,
    "backgroundColor": "#a5d8ff", "fillStyle": "solid", "label": { "text": "Hello", "fontSize": 24 } }
]
```

## Exports

- Browser UI: Export menu (SVG/PNG)
- API: `/view/:viewId/export.svg` and `/view/:viewId/export.png`

## License

MIT
