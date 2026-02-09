import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import crypto from "node:crypto";
import { z } from "zod/v4";
import type { CheckpointStore } from "./checkpoint-store.js";

export type LiveViewHub = {
  getBaseUrl: () => string;
  createView: (opts?: { title?: string; description?: string; skin?: string }) => { viewId: string; url: string };
  updateView: (viewId: string, payload: { elements: any[]; checkpointId?: string }) => void;
  hasView: (viewId: string) => boolean;
  listViews: () => Array<{ viewId: string; url: string; title?: string; description?: string; skin?: string; lastCheckpointId?: string; updatedAt?: string }>;
  updateViewMeta: (viewId: string, meta: { title?: string; description?: string; skin?: string }) => boolean;
  closeView: (viewId: string) => boolean;
  setSelection: (viewId: string, selection: { bounds: { x: number; y: number; width: number; height: number; viewBox?: { x: number; y: number; width: number; height: number } }; pngBase64?: string; updatedAt?: string }) => boolean;
  getSelection: (viewId: string) => { bounds: { x: number; y: number; width: number; height: number; viewBox?: { x: number; y: number; width: number; height: number } }; pngBase64?: string; updatedAt?: string } | null;
  clearSelection: (viewId: string) => boolean;
  getImage: (viewId: string) => { svg?: string; pngBase64?: string; updatedAt?: string } | null;
  markImageAccess: (viewId: string) => void;
  getLastImageAccessAt: (viewId: string) => string | null;
  setAllowReplaceAll: (viewId: string, allow: boolean) => boolean;
  getAllowReplaceAll: (viewId: string) => boolean;
  getLastCheckpointId: (viewId: string) => string | null;
  startChunkedUpdate: (viewId: string) => boolean;
  appendChunkedUpdate: (viewId: string, elements: any[], bytes: number) => { totalElements: number; totalBytes: number } | null;
  consumeChunkedUpdate: (viewId: string) => { elements: any[]; totalBytes: number } | null;
};

// Excalidraw libraries index (public)
const LIBRARIES_INDEX_URL = "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main/libraries.json";
const LIBRARIES_BASE_URL = "https://raw.githubusercontent.com/excalidraw/excalidraw-libraries/main";
const LIBRARIES_INDEX_TTL_MS = 30 * 60 * 1000;

type LibraryIndexItem = {
  id: string;
  name: string;
  description?: string;
  authors?: Array<{ name: string; url?: string; github?: string; twitter?: string }>;
  source: string;
  preview?: string;
  created?: string;
  updated?: string;
  version?: number;
  itemNames?: string[];
};

type LibraryFile = {
  type?: string;
  version?: number;
  source?: string;
  library?: any[];
  libraryItems?: Array<{ id?: string; status?: string; elements?: any[] } | any[]>;
};

let librariesIndexCache: { fetchedAt: number; data: LibraryIndexItem[] } | null = null;

function librarySourceUrl(source: string): string {
  return `${LIBRARIES_BASE_URL}/libraries/${source}`;
}

function libraryPreviewUrl(preview?: string): string | undefined {
  if (!preview) return undefined;
  return `${LIBRARIES_BASE_URL}/previews/${preview}`;
}

async function fetchLibrariesIndex(): Promise<LibraryIndexItem[]> {
  const now = Date.now();
  if (librariesIndexCache && (now - librariesIndexCache.fetchedAt) < LIBRARIES_INDEX_TTL_MS) {
    return librariesIndexCache.data;
  }
  const res = await fetch(LIBRARIES_INDEX_URL);
  if (!res.ok) throw new Error(`libraries index fetch failed: ${res.status}`);
  const data = (await res.json()) as LibraryIndexItem[];
  librariesIndexCache = { fetchedAt: now, data };
  return data;
}

function matchesLibraryQuery(item: LibraryIndexItem, query: string): boolean {
  const q = query.toLowerCase();
  const fields: string[] = [item.name, item.description ?? "", item.source ?? "", item.id ?? ""];
  for (const a of item.authors ?? []) fields.push(a.name ?? "");
  for (const n of item.itemNames ?? []) fields.push(n);
  return fields.join("\n").toLowerCase().includes(q);
}

function scoreLibraryMatch(item: LibraryIndexItem, query: string, itemName?: string): number {
  const q = query.toLowerCase();
  let score = 0;
  if (item.name.toLowerCase().includes(q)) score += 3;
  if ((item.description ?? "").toLowerCase().includes(q)) score += 2;
  if ((item.source ?? "").toLowerCase().includes(q)) score += 1;
  for (const a of item.authors ?? []) {
    if ((a.name ?? "").toLowerCase().includes(q)) score += 1;
  }
  if (itemName && Array.isArray(item.itemNames)) {
    const n = itemName.toLowerCase();
    if (item.itemNames.some((it) => it.toLowerCase() === n)) score += 5;
    if (item.itemNames.some((it) => it.toLowerCase().includes(n))) score += 2;
  }
  return score;
}

async function fetchLibraryFileById(id: string): Promise<{ lib: LibraryIndexItem; file: LibraryFile; url: string }> {
  const all = await fetchLibrariesIndex();
  const lib = all.find((l) => l.id === id);
  if (!lib) {
    throw new Error(`Library id not found: "${id}".`);
  }
  const url = librarySourceUrl(lib.source);
  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Failed to fetch library file (${res.status}).`);
  }
  const file = (await res.json()) as LibraryFile;
  return { lib, file, url };
}

function extractLibraryItems(file: LibraryFile): any[][] {
  if (Array.isArray(file.library)) {
    return file.library
      .map((item) => (Array.isArray(item) ? item : (item as any)?.elements))
      .filter((item): item is any[] => Array.isArray(item) && item.length > 0);
  }
  if (Array.isArray(file.libraryItems)) {
    return file.libraryItems
      .map((item) => (Array.isArray(item) ? item : (item as any)?.elements))
      .filter((item): item is any[] => Array.isArray(item) && item.length > 0);
  }
  return [];
}

async function parseAndResolveElements(elements: string, store: CheckpointStore): Promise<
  | { ok: true; parsed: any[]; resolvedElements: any[]; ratioHint: string }
  | { ok: false; error: string }
> {
  let parsed: any;
  try {
    parsed = JSON.parse(elements);
  } catch (err) {
    return { ok: false, error: `Invalid JSON: ${(err as Error).message}` };
  }

  if (!Array.isArray(parsed)) {
    return { ok: false, error: "Expected a JSON array of Excalidraw elements." };
  }

  const resolvedElements: any[] = [];
  let ratioHint = "";

  for (const el of parsed) {
    if (el && el.type === "restoreCheckpoint" && typeof el.id === "string") {
      const cp = await store.load(el.id);
      if (cp?.elements) resolvedElements.push(...cp.elements);
      continue;
    }

    if (el && el.type === "delete" && typeof el.ids === "string") {
      const ids = el.ids.split(",").map((s: string) => s.trim()).filter(Boolean);
      for (const id of ids) {
        const idx = resolvedElements.findIndex((e) => e?.id === id);
        if (idx >= 0) resolvedElements.splice(idx, 1);
      }
      continue;
    }

    if (el && el.type === "cameraUpdate" && el.width && el.height) {
      const ratio = el.width / el.height;
      if (Math.abs(ratio - 4 / 3) > 0.05) {
        ratioHint = `Camera ratio is ${ratio.toFixed(2)} (ideal ~1.33). Consider 4:3-ish for better fit.`;
      }
      resolvedElements.push(el);
      continue;
    }

    resolvedElements.push(el);
  }

  return { ok: true, parsed, resolvedElements, ratioHint };
}

function computeMinXY(elements: any[]): { minX: number; minY: number } {
  let minX = Infinity;
  let minY = Infinity;
  for (const el of elements) {
    if (!el || typeof el.x !== "number" || typeof el.y !== "number") continue;
    minX = Math.min(minX, el.x);
    minY = Math.min(minY, el.y);
    if (Array.isArray(el.points)) {
      for (const pt of el.points) {
        if (!Array.isArray(pt) || pt.length < 2) continue;
        minX = Math.min(minX, el.x + pt[0]);
        minY = Math.min(minY, el.y + pt[1]);
      }
    }
  }
  if (!isFinite(minX)) minX = 0;
  if (!isFinite(minY)) minY = 0;
  return { minX, minY };
}

function remapLibraryItemElements(rawElements: any[], opts: { x?: number; y?: number }): any[] {
  const { minX, minY } = computeMinXY(rawElements);
  const dx = (opts.x ?? 0) - minX;
  const dy = (opts.y ?? 0) - minY;

  const idPrefix = crypto.randomUUID().replace(/-/g, "").slice(0, 8);
  const idMap = new Map<string, string>();
  const groupMap = new Map<string, string>();

  const mapId = (id?: string) => {
    if (!id) return id;
    if (!idMap.has(id)) idMap.set(id, `${idPrefix}_${idMap.size}`);
    return idMap.get(id)!;
  };
  const mapGroup = (id?: string) => {
    if (!id) return id;
    if (!groupMap.has(id)) groupMap.set(id, `${idPrefix}_g${groupMap.size}`);
    return groupMap.get(id)!;
  };

  return rawElements.map((el) => {
    const next = { ...el };
    if (typeof next.id === "string") next.id = mapId(next.id);
    if (typeof next.containerId === "string") next.containerId = mapId(next.containerId);
    if (typeof next.frameId === "string") next.frameId = mapId(next.frameId);
    if (Array.isArray(next.groupIds)) next.groupIds = next.groupIds.map(mapGroup);
    if (Array.isArray(next.boundElementIds)) next.boundElementIds = next.boundElementIds.map(mapId);
    if (Array.isArray(next.boundElements)) {
      next.boundElements = next.boundElements.map((b: any) => ({ ...b, id: mapId(b?.id) }));
    }
    if (next.startBinding?.elementId) {
      next.startBinding = { ...next.startBinding, elementId: mapId(next.startBinding.elementId) };
    }
    if (next.endBinding?.elementId) {
      next.endBinding = { ...next.endBinding, elementId: mapId(next.endBinding.elementId) };
    }
    if (typeof next.x === "number") next.x += dx;
    if (typeof next.y === "number") next.y += dy;
    return next;
  });
}

const RECALL_CHEAT_SHEET = `# Excalichat quick guide

Flow: create_browser_view -> open URL -> get_view_image -> update.
Prefer update_browser_view_delta for small, fast edits.
If selection exists: only edit inside it, pass selectionAck + editBounds.
Incremental edit pattern: restoreCheckpoint(id) + delete(ids) + new elements.
cameraUpdate: {type:"cameraUpdate",x,y,width,height}
`;

export function createServerWithLiveViews(store: CheckpointStore, liveViews: LiveViewHub): McpServer {
  const server = new McpServer({ name: "Excalichat", version: "0.1.0" });
  const MAX_PENDING_BYTES = 5_000_000;
  const MAX_PENDING_ELEMENTS = 10_000;

  server.registerTool(
    "read_me",
    {
      description: "Returns a condensed Excalidraw elements cheat sheet for incremental updates.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => ({ content: [{ type: "text", text: RECALL_CHEAT_SHEET }] }),
  );

  server.registerTool(
    "viewer_info",
    {
      description:
        "Returns the sidecar viewer base URL. Flow: create_browser_view -> open URL -> update_browser_view -> live reload.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      const baseUrl = liveViews.getBaseUrl();
      return {
        content: [{ type: "text", text: `Viewer base URL: ${baseUrl}` }],
        structuredContent: { baseUrl },
      };
    },
  );

  server.registerTool(
    "create_browser_view",
    {
      description:
        "Create a live-updating browser view (sidecar) and return its URL. Open it in any browser. Then call update_browser_view to live-reload the diagram.",
      inputSchema: z.object({
        title: z.string().optional().describe("Short human-readable name for this diagram."),
        description: z.string().optional().describe("Optional longer description for this diagram."),
        skin: z.string().optional().describe("Optional viewer skin/theme (viewer-only; does not affect element JSON)."),
      }),
    },
    async ({ title, description, skin }): Promise<CallToolResult> => {
      const { viewId, url } = liveViews.createView({ title, description, skin });
      return {
        content: [{ type: "text", text: `Open this in your browser: ${url}\nView id: ${viewId}` }],
        structuredContent: { viewId, url, baseUrl: liveViews.getBaseUrl() },
      };
    },
  );

  server.registerTool(
    "update_browser_view",
    {
      description:
        "Update a view with an elements array. Use get_view_image first. If selection exists, pass selectionAck + editBounds. Default preserves existing elements; use replaceAll=true only for full replace.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        elements: z.string().describe("JSON array string of Excalidraw elements"),
        selectionAck: z.boolean().optional().describe("Set true if a selection exists and you are limiting changes to it."),
        editBounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }).optional().describe("Bounds of the edit area in viewBox coordinates (required if selection exists)."),
        replaceAll: z.boolean().optional().describe("If true, allow overwriting the entire diagram (no restoreCheckpoint required).")
      }),
    },
    async ({ viewId, elements, selectionAck, editBounds, replaceAll }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return {
          content: [{ type: "text", text: `Unknown view id: "${viewId}". Call create_browser_view first.` }],
          isError: true,
        };
      }

      const lastImageAccess = liveViews.getLastImageAccessAt(viewId);
      if (!lastImageAccess) {
        return {
          content: [{
            type: "text",
            text: `No rendered image fetched yet for view "${viewId}". Call get_view_image first, then retry update_browser_view.`,
          }],
          isError: true,
        };
      }

      const selection = liveViews.getSelection(viewId);
      if (selection && !selectionAck) {
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". You must edit only within the selected bounds.\n` +
              `Steps: (1) call get_view_selection, (2) compute your edit area, (3) re-run update_browser_view with selectionAck=true and editBounds.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && !editBounds) {
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". Provide editBounds (x,y,width,height) in viewBox coordinates and ensure edits stay within the selection.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && editBounds) {
        const sel = selection.bounds;
        const within =
          editBounds.x >= sel.x &&
          editBounds.y >= sel.y &&
          (editBounds.x + editBounds.width) <= (sel.x + sel.width) &&
          (editBounds.y + editBounds.height) <= (sel.y + sel.height);
        if (!within) {
          return {
            content: [{
              type: "text",
              text:
                `editBounds is outside the active selection for view "${viewId}". Limit edits to the selected region and retry with editBounds fully inside it.\n` +
                `Selection bounds: ${JSON.stringify(selection.bounds)}\n` +
                `Your editBounds: ${JSON.stringify(editBounds)}`,
            }],
            isError: true,
          };
        }
      }

      const parsed = await parseAndResolveElements(elements, store);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: parsed.error }], isError: true };
      }

      if (replaceAll && !liveViews.getAllowReplaceAll(viewId)) {
        return {
          content: [{
            type: "text",
            text:
              `replaceAll is blocked for view "${viewId}" to prevent accidental wipes.\n` +
              `If you really need a full replacement, call allow_replace_all(viewId, true) first, then retry update_browser_view with replaceAll=true.`,
          }],
          isError: true,
        };
      }

      if (!replaceAll) {
        const hasRestore = parsed.parsed.some((el) => el && el.type === "restoreCheckpoint");
        if (!hasRestore) {
          return {
            content: [{
              type: "text",
              text:
                `This update would overwrite the entire diagram. You must include restoreCheckpoint first to preserve existing elements.\n` +
                `Steps: (1) get the last checkpointId from your previous update, (2) prepend {"type":"restoreCheckpoint","id":"<checkpointId>"} to elements, (3) then add only new/replacement elements or delete(ids).\n` +
                `If you really want to replace everything, set replaceAll=true.`,
            }],
            isError: true,
          };
        }
      }

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: parsed.resolvedElements });

      liveViews.updateView(viewId, {
        elements: parsed.resolvedElements,
        checkpointId,
      });

      const sizeWarn = elements.length > 20000
        ? "\nNote: Large payload. Prefer update_browser_view_delta for faster partial edits."
        : "";
      const hint = parsed.ratioHint ? `\nHint: ${parsed.ratioHint}` : "";

      return {
        content: [{ type: "text", text: `Updated browser view "${viewId}". Checkpoint id: "${checkpointId}".${hint}${sizeWarn}` }],
        structuredContent: { viewId, checkpointId, sizeWarning: sizeWarn ? "large-payload" : undefined },
      };
    },
  );

  server.registerTool(
    "update_browser_view_chunked",
    {
      description:
        "Chunked baseline update. Send the elements array in smaller chunks: call with start=true for the first chunk, then append more chunks, and finish with final=true to commit the update.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        elementsChunk: z.string().describe("JSON array string of Excalidraw elements for this chunk."),
        start: z.boolean().optional().describe("If true, clears any pending chunks for this view before appending."),
        final: z.boolean().optional().describe("If true, commits the pending chunks as a single update."),
        selectionAck: z.boolean().optional().describe("Set true if a selection exists and you are limiting changes to it."),
        editBounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }).optional().describe("Bounds of the edit area in viewBox coordinates (required if selection exists)."),
        replaceAll: z.boolean().optional().describe("If true, allow overwriting the entire diagram (no restoreCheckpoint required)."),
      }),
    },
    async ({ viewId, elementsChunk, start, final, selectionAck, editBounds, replaceAll }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return {
          content: [{ type: "text", text: `Unknown view id: "${viewId}". Call create_browser_view first.` }],
          isError: true,
        };
      }

      if (start) {
        liveViews.startChunkedUpdate(viewId);
      }

      let chunkElements: any;
      try {
        chunkElements = JSON.parse(elementsChunk);
      } catch (err) {
        return { content: [{ type: "text", text: `Invalid JSON: ${(err as Error).message}` }], isError: true };
      }
      if (!Array.isArray(chunkElements)) {
        return {
          content: [{ type: "text", text: "elementsChunk must be a JSON array of Excalidraw elements." }],
          isError: true,
        };
      }

      const appended = liveViews.appendChunkedUpdate(viewId, chunkElements, elementsChunk.length);
      if (!appended) {
        return {
          content: [{ type: "text", text: `Unknown view id: "${viewId}".` }],
          isError: true,
        };
      }

      if (appended.totalBytes > MAX_PENDING_BYTES || appended.totalElements > MAX_PENDING_ELEMENTS) {
        liveViews.consumeChunkedUpdate(viewId);
        return {
          content: [{
            type: "text",
            text:
              `Chunked update exceeds limits (${appended.totalBytes} bytes, ${appended.totalElements} elements). ` +
              `Cleared pending chunks. Reduce chunk size or split into smaller diagrams.`,
          }],
          isError: true,
        };
      }

      if (!final) {
        return {
          content: [{ type: "text", text: `Chunk appended for view "${viewId}". Pending: ${appended.totalElements} elements (${appended.totalBytes} bytes).` }],
          structuredContent: { viewId, pendingElements: appended.totalElements, pendingBytes: appended.totalBytes },
        };
      }

      const lastImageAccess = liveViews.getLastImageAccessAt(viewId);
      if (!lastImageAccess) {
        liveViews.consumeChunkedUpdate(viewId);
        return {
          content: [{
            type: "text",
            text: `No rendered image fetched yet for view "${viewId}". Call get_view_image first, then retry update_browser_view_chunked.`,
          }],
          isError: true,
        };
      }

      const selection = liveViews.getSelection(viewId);
      if (selection && !selectionAck) {
        liveViews.consumeChunkedUpdate(viewId);
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". You must edit only within the selected bounds.\n` +
              `Steps: (1) call get_view_selection, (2) compute your edit area, (3) re-run update_browser_view_chunked with selectionAck=true and editBounds.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && !editBounds) {
        liveViews.consumeChunkedUpdate(viewId);
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". Provide editBounds (x,y,width,height) in viewBox coordinates and ensure edits stay within the selection.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && editBounds) {
        const sel = selection.bounds;
        const within =
          editBounds.x >= sel.x &&
          editBounds.y >= sel.y &&
          (editBounds.x + editBounds.width) <= (sel.x + sel.width) &&
          (editBounds.y + editBounds.height) <= (sel.y + sel.height);
        if (!within) {
          liveViews.consumeChunkedUpdate(viewId);
          return {
            content: [{
              type: "text",
              text:
                `editBounds is outside the active selection for view "${viewId}". Limit edits to the selected region and retry with editBounds fully inside it.\n` +
                `Selection bounds: ${JSON.stringify(selection.bounds)}\n` +
                `Your editBounds: ${JSON.stringify(editBounds)}`,
            }],
            isError: true,
          };
        }
      }

      if (replaceAll && !liveViews.getAllowReplaceAll(viewId)) {
        liveViews.consumeChunkedUpdate(viewId);
        return {
          content: [{
            type: "text",
            text:
              `replaceAll is blocked for view "${viewId}" to prevent accidental wipes.\n` +
              `If you really need a full replacement, call allow_replace_all(viewId, true) first, then retry update_browser_view_chunked with replaceAll=true.`,
          }],
          isError: true,
        };
      }

      const pending = liveViews.consumeChunkedUpdate(viewId);
      const combined = pending?.elements ?? [];
      if (combined.length === 0) {
        return { content: [{ type: "text", text: "No pending chunks to commit." }], isError: true };
      }

      if (!replaceAll) {
        const hasRestore = combined.some((el) => el && el.type === "restoreCheckpoint");
        if (!hasRestore) {
          return {
            content: [{
              type: "text",
              text:
                `This update would overwrite the entire diagram. You must include restoreCheckpoint first to preserve existing elements.\n` +
                `If you really want to replace everything, set replaceAll=true.`,
            }],
            isError: true,
          };
        }
      }

      const parsed = await parseAndResolveElements(JSON.stringify(combined), store);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: parsed.error }], isError: true };
      }

      const checkpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(checkpointId, { elements: parsed.resolvedElements });
      liveViews.updateView(viewId, { elements: parsed.resolvedElements, checkpointId });

      const hint = parsed.ratioHint ? `\nHint: ${parsed.ratioHint}` : "";
      return {
        content: [{ type: "text", text: `Updated browser view "${viewId}". Checkpoint id: "${checkpointId}".${hint}` }],
        structuredContent: { viewId, checkpointId },
      };
    },
  );

  server.registerTool(
    "update_browser_view_delta",
    {
      description:
        "Fast incremental update. Sends only deltas and uses the last checkpoint automatically. Upsert elements replace existing ones with the same id.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        upsertElements: z.array(z.any()).optional().describe("New or replacement elements to add/update."),
        deleteIds: z.array(z.string()).optional().describe("Element ids to delete."),
        selectionAck: z.boolean().optional().describe("Set true if a selection exists and you are limiting changes to it."),
        editBounds: z.object({
          x: z.number(),
          y: z.number(),
          width: z.number(),
          height: z.number(),
        }).optional().describe("Bounds of the edit area in viewBox coordinates (required if selection exists)."),
      }),
    },
    async ({ viewId, upsertElements, deleteIds, selectionAck, editBounds }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return {
          content: [{ type: "text", text: `Unknown view id: "${viewId}". Call create_browser_view first.` }],
          isError: true,
        };
      }

      const lastImageAccess = liveViews.getLastImageAccessAt(viewId);
      if (!lastImageAccess) {
        return {
          content: [{
            type: "text",
            text: `No rendered image fetched yet for view "${viewId}". Call get_view_image first, then retry update_browser_view_delta.`,
          }],
          isError: true,
        };
      }

      const selection = liveViews.getSelection(viewId);
      if (selection && !selectionAck) {
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". You must edit only within the selected bounds.\n` +
              `Steps: (1) call get_view_selection, (2) compute your edit area, (3) re-run update_browser_view_delta with selectionAck=true and editBounds.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && !editBounds) {
        return {
          content: [{
            type: "text",
            text:
              `Selection is active for view "${viewId}". Provide editBounds (x,y,width,height) in viewBox coordinates and ensure edits stay within the selection.\n` +
              `Selection bounds: ${JSON.stringify(selection.bounds)}`,
          }],
          isError: true,
        };
      }
      if (selection && editBounds) {
        const sel = selection.bounds;
        const within =
          editBounds.x >= sel.x &&
          editBounds.y >= sel.y &&
          (editBounds.x + editBounds.width) <= (sel.x + sel.width) &&
          (editBounds.y + editBounds.height) <= (sel.y + sel.height);
        if (!within) {
          return {
            content: [{
              type: "text",
              text:
                `editBounds is outside the active selection for view "${viewId}". Limit edits to the selected region and retry with editBounds fully inside it.\n` +
                `Selection bounds: ${JSON.stringify(selection.bounds)}\n` +
                `Your editBounds: ${JSON.stringify(editBounds)}`,
            }],
            isError: true,
          };
        }
      }

      const checkpointId = liveViews.getLastCheckpointId(viewId);
      if (!checkpointId) {
        return {
          content: [{
            type: "text",
            text: `No checkpoint found for view "${viewId}". Call update_browser_view once to establish a baseline.`,
          }],
          isError: true,
        };
      }

      const upserts = Array.isArray(upsertElements) ? upsertElements : [];
      const deletes = Array.isArray(deleteIds) ? deleteIds : [];
      if (upserts.length === 0 && deletes.length === 0) {
        return {
          content: [{ type: "text", text: `No changes provided. Supply upsertElements and/or deleteIds.` }],
          isError: true,
        };
      }

      const deleteSet = new Set<string>(deletes);
      for (const el of upserts) {
        if (el && typeof el.id === "string") deleteSet.add(el.id);
      }

      const elementsPayload: any[] = [
        { type: "restoreCheckpoint", id: checkpointId },
      ];
      if (deleteSet.size > 0) {
        elementsPayload.push({ type: "delete", ids: Array.from(deleteSet).join(",") });
      }
      if (upserts.length > 0) {
        elementsPayload.push(...upserts);
      }

      const parsed = await parseAndResolveElements(JSON.stringify(elementsPayload), store);
      if (!parsed.ok) {
        return { content: [{ type: "text", text: parsed.error }], isError: true };
      }

      const newCheckpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      await store.save(newCheckpointId, { elements: parsed.resolvedElements });
      liveViews.updateView(viewId, { elements: parsed.resolvedElements, checkpointId: newCheckpointId });

      return {
        content: [{ type: "text", text: `Updated browser view "${viewId}". Checkpoint id: "${newCheckpointId}".` }],
        structuredContent: { viewId, checkpointId: newCheckpointId },
      };
    },
  );

  server.registerTool(
    "list_browser_views",
    {
      description: "List all live browser views (diagrams) in this server process.",
      inputSchema: z.object({}),
      annotations: { readOnlyHint: true },
    },
    async (): Promise<CallToolResult> => {
      const views = liveViews.listViews();
      return {
        content: [{ type: "text", text: views.length ? views.map((v) => `${v.viewId} ${v.title ?? ""} ${v.url}`).join("\n") : "(no views yet)" }],
        structuredContent: { views },
      };
    },
  );

  server.registerTool(
    "set_browser_view_meta",
    {
      description: "Update a browser view's title/description/skin.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        title: z.string().optional().describe("Short name"),
        description: z.string().optional().describe("Longer note"),
        skin: z.string().optional().describe("Viewer skin/theme name"),
      }),
    },
    async ({ viewId, title, description, skin }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      const ok = liveViews.updateViewMeta(viewId, { title, description, skin });
      return {
        content: [{ type: "text", text: ok ? `Updated metadata for view "${viewId}".` : `Failed to update metadata for view "${viewId}".` }],
        structuredContent: { viewId, ok },
      };
    },
  );

  server.registerTool(
    "close_browser_view",
    {
      description: "Close a browser view and disconnect any open viewer tabs.",
      inputSchema: z.object({ viewId: z.string().describe("View id returned by create_browser_view") }),
    },
    async ({ viewId }): Promise<CallToolResult> => {
      const ok = liveViews.closeView(viewId);
      if (!ok) return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      return { content: [{ type: "text", text: `Closed view "${viewId}".` }], structuredContent: { viewId, ok } };
    },
  );

  server.registerTool(
    "allow_replace_all",
    {
      description: "Explicitly allow a full-diagram replacement for a view (guardrail to prevent accidental wipes).",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        allow: z.boolean().describe("Set true to allow replaceAll; set false to lock it again.")
      }),
    },
    async ({ viewId, allow }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      const ok = liveViews.setAllowReplaceAll(viewId, allow);
      return {
        content: [{ type: "text", text: ok ? `replaceAll is now ${allow ? "ENABLED" : "DISABLED"} for view "${viewId}".` : `Failed to update replaceAll guard for view "${viewId}".` }],
        structuredContent: { viewId, allow, ok },
      };
    },
  );

  server.registerTool(
    "get_view_image",
    {
      description:
        "Return the latest rendered image or export URLs. Use inline=true only if you need base64/SVG text.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
        format: z.enum(["png", "svg"]).optional().describe("Image format (default png)."),
        inline: z.boolean().optional().describe("If true, return base64/svg text inline instead of URLs (slower)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ viewId, format, inline }): Promise<CallToolResult> => {
      const img = liveViews.getImage(viewId);
      if (!img) {
        return { content: [{ type: "text", text: `No cached image for view id: "${viewId}".` }], isError: true };
      }
      liveViews.markImageAccess(viewId);
      const fmt = format ?? "png";
      const baseUrl = liveViews.getBaseUrl();
      const svgUrl = `${baseUrl}/view/${viewId}/export.svg`;
      const pngUrl = `${baseUrl}/view/${viewId}/export.png`;
      if (!inline) {
        return {
          content: [{ type: "text", text: `Export URLs:\nSVG: ${svgUrl}\nPNG: ${pngUrl}` }],
          structuredContent: { viewId, format: fmt, svgUrl, pngUrl, updatedAt: img.updatedAt },
        };
      }
      if (fmt === "svg") {
        if (!img.svg) {
          return { content: [{ type: "text", text: `No cached SVG for view id: "${viewId}".` }], isError: true };
        }
        return {
          content: [{ type: "text", text: img.svg }],
          structuredContent: { viewId, format: "svg", updatedAt: img.updatedAt },
        };
      }
      if (!img.pngBase64) {
        return { content: [{ type: "text", text: `No cached PNG for view id: "${viewId}".` }], isError: true };
      }
      return {
        content: [{ type: "text", text: img.pngBase64 }],
        structuredContent: { viewId, format: "png", updatedAt: img.updatedAt, pngBase64: img.pngBase64 },
      };
    },
  );

  server.registerTool(
    "get_view_export_urls",
    {
      description: "Return direct export URLs for SVG/PNG for a view.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ viewId }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      const baseUrl = liveViews.getBaseUrl();
      const svgUrl = `${baseUrl}/view/${viewId}/export.svg`;
      const pngUrl = `${baseUrl}/view/${viewId}/export.png`;
      liveViews.markImageAccess(viewId);
      return {
        content: [{ type: "text", text: `Export URLs:\nSVG: ${svgUrl}\nPNG: ${pngUrl}` }],
        structuredContent: { viewId, svgUrl, pngUrl },
      };
    },
  );

  server.registerTool(
    "get_view_checkpoint",
    {
      description: "Return the latest checkpointId for a view (used for fast delta updates).",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ viewId }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      const checkpointId = liveViews.getLastCheckpointId(viewId);
      if (!checkpointId) {
        return { content: [{ type: "text", text: `No checkpoint yet for view "${viewId}".` }], isError: true };
      }
      return {
        content: [{ type: "text", text: `Latest checkpoint for view "${viewId}": ${checkpointId}` }],
        structuredContent: { viewId, checkpointId },
      };
    },
  );

  server.registerTool(
    "get_view_selection",
    {
      description: "Return the last user selection box from the viewer (bounds in viewBox coordinates, optional PNG crop if available).",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ viewId }): Promise<CallToolResult> => {
      const sel = liveViews.getSelection(viewId);
      if (!sel) {
        return { content: [{ type: "text", text: `No selection for view id: "${viewId}".` }], isError: true };
      }
      const note = sel.pngBase64 ? " (includes pngBase64)" : "";
      return {
        content: [{ type: "text", text: `Selection for view "${viewId}": ${JSON.stringify(sel.bounds)}${note}` }],
        structuredContent: { viewId, selection: sel },
      };
    },
  );

  server.registerTool(
    "clear_view_selection",
    {
      description: "Clear the stored selection for a view.",
      inputSchema: z.object({
        viewId: z.string().describe("View id returned by create_browser_view"),
      }),
    },
    async ({ viewId }): Promise<CallToolResult> => {
      const ok = liveViews.clearSelection(viewId);
      if (!ok) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      return { content: [{ type: "text", text: `Cleared selection for view "${viewId}".` }], structuredContent: { viewId, ok } };
    },
  );

  server.registerTool(
    "list_libraries",
    {
      description:
        "Search the public Excalidraw libraries index and return matching libraries (id, name, description, author, download URL).",
      inputSchema: z.object({
        query: z.string().optional().describe("Search text (matches name, description, authors, item names)."),
        limit: z.number().int().min(1).max(50).optional().describe("Max results (default 10)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      try {
        const all = await fetchLibrariesIndex();
        const filtered = query ? all.filter((item) => matchesLibraryQuery(item, query)) : all;
        const take = filtered.slice(0, limit ?? 10).map((item) => ({
          id: item.id,
          name: item.name,
          description: item.description,
          authors: item.authors ?? [],
          source: item.source,
          sourceUrl: librarySourceUrl(item.source),
          previewUrl: libraryPreviewUrl(item.preview),
          updated: item.updated,
          created: item.created,
          itemNames: item.itemNames ?? [],
        }));

        return {
          content: [{
            type: "text",
            text: `Excalidraw libraries${query ? ` for "${query}"` : ""}:\n${take.map((i) => `- ${i.id} ${i.name}`).join("\n")}`,
          }],
          structuredContent: { query: query ?? "", total: filtered.length, libraries: take },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to load libraries index: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "suggest_libraries",
    {
      description:
        "Suggest the best-matching Excalidraw libraries for a prompt or keyword (ranked). Returns previews and download URLs.",
      inputSchema: z.object({
        query: z.string().describe("What you need (e.g., 'aws icons', 'system design', 'wireframes')."),
        limit: z.number().int().min(1).max(20).optional().describe("Max suggestions (default 5)."),
      }),
      annotations: { readOnlyHint: true },
    },
    async ({ query, limit }): Promise<CallToolResult> => {
      try {
        const all = await fetchLibrariesIndex();
        const ranked = all
          .map((item) => ({ item, score: scoreLibraryMatch(item, query) }))
          .filter((r) => r.score > 0)
          .sort((a, b) => b.score - a.score);

        const take = ranked.slice(0, limit ?? 5).map((r) => ({
          id: r.item.id,
          name: r.item.name,
          description: r.item.description,
          authors: r.item.authors ?? [],
          source: r.item.source,
          sourceUrl: librarySourceUrl(r.item.source),
          previewUrl: libraryPreviewUrl(r.item.preview),
          updated: r.item.updated,
          created: r.item.created,
          itemNames: r.item.itemNames ?? [],
          score: r.score,
        }));

        return {
          content: [{ type: "text", text: `Suggested libraries for "${query}":\n${take.map((i) => `- ${i.id} ${i.name}`).join("\n")}` }],
          structuredContent: { query, suggestions: take },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to load libraries index: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "get_library",
    {
      description: "Fetch a specific Excalidraw library file by id (returns the raw excalidrawlib JSON).",
      inputSchema: z.object({ id: z.string().describe("Library id (from list_libraries).") }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const { lib, url } = await fetchLibraryFileById(id);
        const res = await fetch(url);
        if (!res.ok) return { content: [{ type: "text", text: `Failed to fetch library file (${res.status}).` }], isError: true };
        const text = await res.text();
        return { content: [{ type: "text", text }], structuredContent: { id, name: lib.name, sourceUrl: url } };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to fetch library: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "list_library_items",
    {
      description: "List available item names for a library id (useful before insert_library_by_name).",
      inputSchema: z.object({ id: z.string().describe("Library id (from list_libraries).") }),
      annotations: { readOnlyHint: true },
    },
    async ({ id }): Promise<CallToolResult> => {
      try {
        const { lib, file } = await fetchLibraryFileById(id);
        const items = extractLibraryItems(file);
        const names = lib.itemNames ?? [];
        const count = items.length;
        const text = names.length
          ? `Library "${lib.name}" items (${names.length}):\n- ${names.join("\n- ")}`
          : `Library "${lib.name}" does not publish itemNames. It contains ${count} items; use insert_library_item with itemIndex.`;
        return { content: [{ type: "text", text }], structuredContent: { id, name: lib.name, itemNames: names, itemCount: count } };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to read library index: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "insert_library_item",
    {
      description:
        "Insert a specific item from an Excalidraw library into a browser view. Fetches the library, picks an item, repositions it, and pushes it into the view.",
      inputSchema: z.object({
        viewId: z.string().describe("Target view id (from create_browser_view)."),
        libraryId: z.string().describe("Library id (from list_libraries)."),
        itemIndex: z.number().int().min(0).optional().describe("Index in the library's item list (default 0)."),
        x: z.number().optional().describe("Target x (top-left) for the item placement."),
        y: z.number().optional().describe("Target y (top-left) for the item placement."),
        checkpointId: z.string().optional().describe("Optional checkpoint to restore before inserting."),
      }),
    },
    async ({ viewId, libraryId, itemIndex, x, y, checkpointId }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      try {
        const { lib, file, url } = await fetchLibraryFileById(libraryId);
        const items = extractLibraryItems(file);
        if (items.length === 0) return { content: [{ type: "text", text: `Library "${lib.name}" has no items.` }], isError: true };

        const idx = itemIndex ?? 0;
        if (idx < 0 || idx >= items.length) {
          return { content: [{ type: "text", text: `itemIndex out of range. Library has ${items.length} items.` }], isError: true };
        }
        const rawElements = items[idx];
        if (!Array.isArray(rawElements) || rawElements.length === 0) {
          return { content: [{ type: "text", text: `Selected library item has no elements.` }], isError: true };
        }

        const remapped = remapLibraryItemElements(rawElements, { x, y });
        const payloadElements: any[] = [];
        if (checkpointId) payloadElements.push({ type: "restoreCheckpoint", id: checkpointId });
        payloadElements.push(...remapped);

        const parsed = await parseAndResolveElements(JSON.stringify(payloadElements), store);
        if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };

        const newCheckpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
        await store.save(newCheckpointId, { elements: parsed.resolvedElements });
        liveViews.updateView(viewId, { elements: parsed.resolvedElements, checkpointId: newCheckpointId });

        return {
          content: [{ type: "text", text: `Inserted library item into view "${viewId}". New checkpoint id: "${newCheckpointId}".` }],
          structuredContent: { viewId, libraryId, itemIndex: idx, checkpointId: newCheckpointId, libraryName: lib.name, sourceUrl: url },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to insert library item: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "insert_library_by_name",
    {
      description:
        "Search libraries by keyword, then insert the best-matching library item by name (or the first item if none match).",
      inputSchema: z.object({
        viewId: z.string().describe("Target view id (from create_browser_view)."),
        query: z.string().describe("Search query (library name/description/authors/item names)."),
        itemName: z.string().optional().describe("Preferred item name within the library (uses itemNames when available)."),
        x: z.number().optional().describe("Target x (top-left) for the item placement."),
        y: z.number().optional().describe("Target y (top-left) for the item placement."),
        checkpointId: z.string().optional().describe("Optional checkpoint to restore before inserting."),
      }),
    },
    async ({ viewId, query, itemName, x, y, checkpointId }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      try {
        const all = await fetchLibrariesIndex();
        const candidates = all
          .filter((item) => matchesLibraryQuery(item, query))
          .map((item) => ({ item, score: scoreLibraryMatch(item, query, itemName) }))
          .sort((a, b) => b.score - a.score);
        if (candidates.length === 0) return { content: [{ type: "text", text: `No libraries matched query "${query}".` }], isError: true };

        const lib = candidates[0].item;
        const { file, url } = await fetchLibraryFileById(lib.id);
        const items = extractLibraryItems(file);
        if (items.length === 0) return { content: [{ type: "text", text: `Library "${lib.name}" has no items.` }], isError: true };

        let idx = 0;
        if (itemName && Array.isArray(lib.itemNames) && lib.itemNames.length === items.length) {
          const exact = lib.itemNames.findIndex((n) => n.toLowerCase() === itemName.toLowerCase());
          const partial = lib.itemNames.findIndex((n) => n.toLowerCase().includes(itemName.toLowerCase()));
          if (exact >= 0) idx = exact; else if (partial >= 0) idx = partial;
        }

        const rawElements = items[idx];
        if (!Array.isArray(rawElements) || rawElements.length === 0) {
          return { content: [{ type: "text", text: `Selected library item has no elements.` }], isError: true };
        }

        const remapped = remapLibraryItemElements(rawElements, { x, y });
        const payloadElements: any[] = [];
        if (checkpointId) payloadElements.push({ type: "restoreCheckpoint", id: checkpointId });
        payloadElements.push(...remapped);

        const parsed = await parseAndResolveElements(JSON.stringify(payloadElements), store);
        if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };

        const newCheckpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
        await store.save(newCheckpointId, { elements: parsed.resolvedElements });
        liveViews.updateView(viewId, { elements: parsed.resolvedElements, checkpointId: newCheckpointId });

        return {
          content: [{ type: "text", text: `Inserted library item into view "${viewId}". New checkpoint id: "${newCheckpointId}".` }],
          structuredContent: { viewId, query, itemName: itemName ?? "", libraryId: lib.id, libraryName: lib.name, itemIndex: idx, checkpointId: newCheckpointId, sourceUrl: url },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to insert library item: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  server.registerTool(
    "insert_library_items",
    {
      description:
        "Insert multiple library items by name from the best-matching library. Names are matched against itemNames when available; missing names are skipped.",
      inputSchema: z.object({
        viewId: z.string().describe("Target view id (from create_browser_view)."),
        query: z.string().describe("Search query (library name/description/authors/item names)."),
        itemNames: z.array(z.string()).min(1).describe("Item names to insert (e.g., ['Lambda','S3'])."),
        startX: z.number().optional().describe("Starting x position (top-left) for first item."),
        startY: z.number().optional().describe("Starting y position (top-left) for first item."),
        gapX: z.number().optional().describe("Horizontal gap between items (default 180)."),
        gapY: z.number().optional().describe("Vertical gap between rows (default 140)."),
        perRow: z.number().int().min(1).optional().describe("Items per row before wrapping (default 4)."),
        checkpointId: z.string().optional().describe("Optional checkpoint to restore before inserting."),
      }),
    },
    async ({ viewId, query, itemNames, startX, startY, gapX, gapY, perRow, checkpointId }): Promise<CallToolResult> => {
      if (!liveViews.hasView(viewId)) {
        return { content: [{ type: "text", text: `Unknown view id: "${viewId}".` }], isError: true };
      }
      try {
        const all = await fetchLibrariesIndex();
        const candidates = all
          .filter((item) => matchesLibraryQuery(item, query))
          .map((item) => ({ item, score: scoreLibraryMatch(item, query) }))
          .sort((a, b) => b.score - a.score);
        if (candidates.length === 0) return { content: [{ type: "text", text: `No libraries matched query "${query}".` }], isError: true };

        const lib = candidates[0].item;
        const { file, url } = await fetchLibraryFileById(lib.id);
        const items = extractLibraryItems(file);
        if (items.length === 0) return { content: [{ type: "text", text: `Library "${lib.name}" has no items.` }], isError: true };

        const nameIndex = new Map<string, number>();
        if (Array.isArray(lib.itemNames) && lib.itemNames.length === items.length) {
          lib.itemNames.forEach((n, i) => nameIndex.set(n.toLowerCase(), i));
        }

        const missing: string[] = [];
        const inserts: Array<{ name: string; elements: any[]; index: number }> = [];
        for (const name of itemNames) {
          const idx = nameIndex.get(name.toLowerCase());
          if (idx == null) {
            missing.push(name);
            continue;
          }
          const rawElements = items[idx];
          if (!Array.isArray(rawElements) || rawElements.length === 0) {
            missing.push(name);
            continue;
          }
          inserts.push({ name, elements: rawElements, index: idx });
        }

        if (inserts.length === 0) {
          return { content: [{ type: "text", text: `No matching items found in library "${lib.name}".` }], isError: true };
        }

        const gx = gapX ?? 180;
        const gy = gapY ?? 140;
        const rowSize = perRow ?? 4;
        const originX = startX ?? 60;
        const originY = startY ?? 60;

        const payloadElements: any[] = [];
        if (checkpointId) payloadElements.push({ type: "restoreCheckpoint", id: checkpointId });

        inserts.forEach((ins, i) => {
          const col = i % rowSize;
          const row = Math.floor(i / rowSize);
          const x = originX + col * gx;
          const y = originY + row * gy;
          const remapped = remapLibraryItemElements(ins.elements, { x, y });
          payloadElements.push(...remapped);
        });

        const parsed = await parseAndResolveElements(JSON.stringify(payloadElements), store);
        if (!parsed.ok) return { content: [{ type: "text", text: parsed.error }], isError: true };

        const newCheckpointId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
        await store.save(newCheckpointId, { elements: parsed.resolvedElements });
        liveViews.updateView(viewId, { elements: parsed.resolvedElements, checkpointId: newCheckpointId });

        return {
          content: [{ type: "text", text: `Inserted ${inserts.length} items into view "${viewId}". New checkpoint id: "${newCheckpointId}".` }],
          structuredContent: { viewId, query, libraryId: lib.id, libraryName: lib.name, inserted: inserts.map((i) => ({ name: i.name, index: i.index })), missing, checkpointId: newCheckpointId, sourceUrl: url },
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Failed to insert library items: ${(err as Error).message}` }], isError: true };
      }
    },
  );

  return server;
}
