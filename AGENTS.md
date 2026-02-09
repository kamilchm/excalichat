# Excalichat — Agent Guidelines

This server is optimized for fast, incremental edits and minimal payloads.

## Core flow (always follow)

1) `create_browser_view` and open the returned URL.
2) `get_view_image` before editing (ensures a fresh render exists).
3) Use **`update_browser_view_delta`** for most edits.

## Partial edits (required behavior)

- If a selection exists, only edit inside it.
- Use `get_view_selection` for bounds.
- Call `update_browser_view_delta` with `selectionAck=true` and `editBounds`.

## Avoid full replacements

- **Do not** use `replaceAll` unless the user explicitly requests a full redraw.
- If you truly need to replace everything, you must first call `allow_replace_all(viewId, true)`.

## Delta updates (recommended)

- Use `update_browser_view_delta` with:
  - `deleteIds` to remove elements
  - `upsertElements` to add or replace elements (matching ids are replaced automatically)
- Keep payloads small and focused on the requested change.

## Checkpoints

- `update_browser_view_delta` auto-restores from the latest checkpoint.
- For full-array updates, always prepend `restoreCheckpoint` unless you intend a full replacement.

## Image access

- `get_view_image` returns export URLs by default; use `inline=true` only if you need base64.
- Use `/view/:viewId/export.png` for quick previews when needed.

## Libraries

- Use `suggest_libraries` and `list_library_items` to pick assets.
- Prefer `insert_library_item(s)` or `insert_library_by_name` for fast insertion.

## Performance tips

- Avoid sending full element arrays unless required.
- Prefer deltas; keep updates small.
- If a user asks for a minor tweak, never replace the entire diagram.
