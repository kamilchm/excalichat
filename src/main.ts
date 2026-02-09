/**
 * Excalichat MCP server entrypoint.
 * Runs MCP over HTTP (Streamable) or stdio, plus a sidecar web viewer (SSE).
 */

import { createMcpExpressApp } from "@modelcontextprotocol/sdk/server/express.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import cors from "cors";
import express from "express";
import type { Request, Response } from "express";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { FileCheckpointStore } from "./checkpoint-store.js";
import { createServerWithLiveViews } from "./server.js";
import type { LiveViewHub } from "./server.js";

type LiveViewState = {
  title?: string;
  description?: string;
  skin?: string;
  clients: Set<Response>;
  lastPayload?: { elements: any[]; checkpointId?: string };
  lastCheckpointId?: string;
  updatedAt?: string;
  lastSvg?: string;
  lastPng?: Buffer;
  lastSelection?: {
    bounds: { x: number; y: number; width: number; height: number; viewBox?: { x: number; y: number; width: number; height: number } };
    pngBase64?: string;
    updatedAt?: string;
  };
  lastImageAccessAt?: string;
  allowReplaceAll?: boolean;
  pendingChunks?: { elements: any[]; totalBytes: number };
  sessionPath?: string;
  createdAt?: string;
};

type LiveViewHubWithState = LiveViewHub & { _views: Map<string, LiveViewState>; setBaseUrl: (url: string) => void };

function sseWrite(res: Response, event: string, data: unknown): void {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

function createLiveViewHub(initialBaseUrl: string): LiveViewHubWithState {
  const views = new Map<string, LiveViewState>();
  let baseUrl = initialBaseUrl;

  const getSessionDir = () => {
    const platform = process.platform;
    if (platform === "win32") {
      const base = process.env.LOCALAPPDATA
        ?? (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : undefined)
        ?? os.tmpdir();
      return path.join(base, "excalichat", "sessions");
    }
    if (platform === "darwin") {
      return path.join(os.homedir(), "Library", "Caches", "excalichat", "sessions");
    }
    const xdg = process.env.XDG_CACHE_HOME;
    const base = xdg && xdg.length > 0 ? xdg : path.join(os.homedir(), ".cache");
    return path.join(base, "excalichat", "sessions");
  };

  const ensureSessionDir = () => {
    const dir = getSessionDir();
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  };

  const sessionFile = (viewId: string) => path.join(ensureSessionDir(), `${viewId}.json`);

  const persistSession = (viewId: string, st: LiveViewState) => {
    try {
      const payload = {
        viewId,
        title: st.title,
        description: st.description,
        skin: st.skin,
        lastCheckpointId: st.lastCheckpointId,
        updatedAt: st.updatedAt,
        createdAt: st.createdAt,
      };
      fs.writeFileSync(sessionFile(viewId), JSON.stringify(payload));
    } catch {}
  };

  const restoreSessions = () => {
    const dir = ensureSessionDir();
    const files = fs.readdirSync(dir).filter((f) => f.endsWith(".json"));
    for (const f of files) {
      try {
        const raw = fs.readFileSync(path.join(dir, f), "utf-8");
        const data = JSON.parse(raw);
        const viewId = data.viewId || f.replace(/\.json$/, "");
        if (views.has(viewId)) continue;
        views.set(viewId, {
          title: data.title,
          description: data.description,
          skin: data.skin,
          clients: new Set(),
          lastCheckpointId: data.lastCheckpointId,
          updatedAt: data.updatedAt,
          createdAt: data.createdAt,
          allowReplaceAll: false,
        });
      } catch {}
    }
  };

  restoreSessions();

  const hub: LiveViewHubWithState = {
    getBaseUrl: () => baseUrl,
    setBaseUrl: (url) => { baseUrl = url; },
    createView: (opts) => {
      const viewId = crypto.randomUUID().replace(/-/g, "").slice(0, 18);
      views.set(viewId, {
        title: opts?.title,
        description: opts?.description,
        skin: opts?.skin,
        clients: new Set(),
        updatedAt: new Date().toISOString(),
        createdAt: new Date().toISOString(),
        allowReplaceAll: false,
      });
      persistSession(viewId, views.get(viewId)!);
      return { viewId, url: `${baseUrl}/view/${viewId}` };
    },
    updateView: (viewId, payload) => {
      const st = views.get(viewId);
      if (!st) return;
      st.lastPayload = payload;
      st.lastCheckpointId = payload.checkpointId;
      st.updatedAt = new Date().toISOString();
      persistSession(viewId, st);
      for (const client of st.clients) {
        try { sseWrite(client, "update", payload); } catch {}
      }
    },
    hasView: (viewId) => views.has(viewId),
    listViews: () => {
      const out: Array<{ viewId: string; url: string; title?: string; description?: string; skin?: string; lastCheckpointId?: string; updatedAt?: string }> = [];
      for (const [viewId, st] of views) {
        out.push({
          viewId,
          url: `${baseUrl}/view/${viewId}`,
          title: st.title,
          description: st.description,
          skin: st.skin,
          lastCheckpointId: st.lastCheckpointId,
          updatedAt: st.updatedAt,
        });
      }
      out.sort((a, b) => String(b.updatedAt ?? "").localeCompare(String(a.updatedAt ?? "")));
      return out;
    },
    updateViewMeta: (viewId, meta) => {
      const st = views.get(viewId);
      if (!st) return false;
      if (meta.title !== undefined) st.title = meta.title;
      if (meta.description !== undefined) st.description = meta.description;
      if (meta.skin !== undefined) st.skin = meta.skin;
      st.updatedAt = new Date().toISOString();
      persistSession(viewId, st);
      const payload = { viewId, title: st.title, description: st.description, skin: st.skin };
      for (const client of st.clients) {
        try { sseWrite(client, "meta", payload); } catch {}
      }
      return true;
    },
    closeView: (viewId) => {
      const st = views.get(viewId);
      if (!st) return false;
      for (const client of st.clients) {
        try { sseWrite(client, "closed", { viewId }); } catch {}
        try { client.end(); } catch {}
      }
      views.delete(viewId);
      try { fs.unlinkSync(sessionFile(viewId)); } catch {}
      return true;
    },
    startChunkedUpdate: (viewId) => {
      const st = views.get(viewId);
      if (!st) return false;
      st.pendingChunks = { elements: [], totalBytes: 0 };
      return true;
    },
    appendChunkedUpdate: (viewId, elements, bytes) => {
      const st = views.get(viewId);
      if (!st) return null;
      if (!st.pendingChunks) st.pendingChunks = { elements: [], totalBytes: 0 };
      st.pendingChunks.elements.push(...elements);
      st.pendingChunks.totalBytes += bytes;
      return { totalElements: st.pendingChunks.elements.length, totalBytes: st.pendingChunks.totalBytes };
    },
    consumeChunkedUpdate: (viewId) => {
      const st = views.get(viewId);
      if (!st || !st.pendingChunks) return null;
      const pending = st.pendingChunks;
      st.pendingChunks = undefined;
      return pending;
    },
    getImage: (viewId) => {
      const st = views.get(viewId);
      if (!st) return null;
      return {
        svg: st.lastSvg,
        pngBase64: st.lastPng ? st.lastPng.toString("base64") : undefined,
        updatedAt: st.updatedAt,
      };
    },
    markImageAccess: (viewId) => {
      const st = views.get(viewId);
      if (!st) return;
      st.lastImageAccessAt = new Date().toISOString();
    },
    getLastImageAccessAt: (viewId) => {
      const st = views.get(viewId);
      return st?.lastImageAccessAt ?? null;
    },
    getLastCheckpointId: (viewId) => {
      const st = views.get(viewId);
      return st?.lastCheckpointId ?? null;
    },
    getSelection: (viewId) => {
      const st = views.get(viewId);
      return st?.lastSelection ?? null;
    },
    setSelection: (viewId, selection) => {
      const st = views.get(viewId);
      if (!st) return false;
      st.lastSelection = selection;
      return true;
    },
    clearSelection: (viewId) => {
      const st = views.get(viewId);
      if (!st) return false;
      st.lastSelection = undefined;
      return true;
    },
    setAllowReplaceAll: (viewId: string, allow: boolean) => {
      const st = views.get(viewId);
      if (!st) return false;
      st.allowReplaceAll = allow;
      return true;
    },
    getAllowReplaceAll: (viewId: string) => {
      const st = views.get(viewId);
      return st?.allowReplaceAll ?? false;
    },
    _views: views,
  };
  return hub;
}

function browserViewCsp(): string {
  return [
    "default-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "img-src 'self' data: blob:",
    "style-src 'self' 'unsafe-inline'",
    "font-src 'self' https://esm.sh data:",
    "script-src 'self' https://esm.sh 'unsafe-inline'",
    "connect-src 'self' https://esm.sh",
  ].join("; ");
}

function browserViewHtml(viewId: string, meta: { title?: string; description?: string; skin?: string }): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Excalichat Live View</title>
    <style>
      :root { color-scheme: light; }
      html, body { height: 100%; }
      body {
        margin: 0;
        font-family: ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        background: var(--bg);
        color: var(--text);
        transition: background 0.3s ease;
      }
      body {
        --bg: #0b1020;
        --text: #e7e9ee;
        --muted: rgba(231,233,238,0.75);
        --stage-bg: rgba(255,255,255,0.04);
        --stage-border: rgba(255,255,255,0.12);
        --canvas-bg: radial-gradient(1200px 700px at 30% 10%, rgba(74,158,237,0.14), rgba(11,16,32,0));
      }
      body[data-skin="paper"] {
        --bg: #f6f4ef;
        --text: #1b1b1b;
        --muted: #5f5f5f;
        --stage-bg: #ffffff;
        --stage-border: #e1e1e1;
        --canvas-bg: repeating-linear-gradient(0deg, rgba(0,0,0,0.04) 0 1px, transparent 1px 24px),
          repeating-linear-gradient(90deg, rgba(0,0,0,0.04) 0 1px, transparent 1px 24px);
      }
      body[data-skin="graph-paper"] {
        --bg: #f3f7fb;
        --text: #1a2733;
        --muted: #5d6b77;
        --stage-bg: #ffffff;
        --stage-border: #d8e1ea;
        --canvas-bg: repeating-linear-gradient(0deg, rgba(74,120,160,0.2) 0 1px, transparent 1px 24px),
          repeating-linear-gradient(90deg, rgba(74,120,160,0.2) 0 1px, transparent 1px 24px);
      }
      body[data-skin="blueprint"] {
        --bg: #0b1f3b;
        --text: #e8f1ff;
        --muted: rgba(232,241,255,0.7);
        --stage-bg: rgba(255,255,255,0.04);
        --stage-border: rgba(255,255,255,0.18);
        --canvas-bg: repeating-linear-gradient(0deg, rgba(120,170,230,0.25) 0 1px, transparent 1px 26px),
          repeating-linear-gradient(90deg, rgba(120,170,230,0.25) 0 1px, transparent 1px 26px);
      }
      body[data-skin="slate"] {
        --bg: #0b1020;
        --text: #e7e9ee;
        --muted: rgba(231,233,238,0.75);
        --stage-bg: rgba(255,255,255,0.04);
        --stage-border: rgba(255,255,255,0.12);
        --canvas-bg: radial-gradient(1200px 700px at 30% 10%, rgba(74,158,237,0.14), rgba(11,16,32,0));
      }
      .wrap { min-height: 100%; position: relative; }
      .meta { display: flex; flex-direction: column; gap: 2px; }
      .brand { font-size: 11px; text-transform: uppercase; letter-spacing: 0.18em; color: var(--muted); }
      .title { font-weight: 600; letter-spacing: 0.2px; font-size: 13px; }
      .sub { font-size: 11px; color: var(--muted); }
      .desc { font-size: 11px; color: var(--muted); }
      .actions { display: flex; align-items: center; gap: 8px; }
      .status { display: inline-flex; align-items: center; gap: 6px; font-size: 11px; color: var(--muted); }
      .status-dot { width: 8px; height: 8px; border-radius: 999px; background: #8892a0; box-shadow: 0 0 0 2px rgba(0,0,0,0.15) inset; }
      .status-dot[data-state="connected"] { background: #22c55e; }
      .status-dot[data-state="reconnecting"] { background: #f59e0b; }
      .status-dot[data-state="closed"] { background: #ef4444; }
      .export-btn { display: inline-flex; align-items: center; gap: 6px; font-size: 12px; padding: 6px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.16); background: rgba(255,255,255,0.04); color: var(--text); cursor: pointer; }
      .export-btn:hover { background: rgba(255,255,255,0.08); }
      .export-menu { position: absolute; top: 100%; right: 0; margin-top: 6px; background: rgba(12,16,26,0.92); border: 1px solid rgba(255,255,255,0.12); border-radius: 8px; padding: 6px; display: none; min-width: 140px; }
      .export-menu[data-open="true"] { display: block; }
      .export-menu button { width: 100%; text-align: left; background: transparent; border: none; color: var(--text); padding: 6px 8px; font-size: 12px; cursor: pointer; }
      .export-menu button:hover { background: rgba(255,255,255,0.08); }
      .canvas { width: 100vw; height: 100vh; display: grid; place-items: center; background: var(--canvas-bg); position: relative; overflow: hidden; }
      .canvas svg { width: 100%; height: 100%; display: block; position: relative; z-index: 1; }
      .overlay { position: absolute; inset: 0; pointer-events: none; z-index: 3; }
      .selection { position: absolute; border: 2px dashed rgba(255,255,255,0.8); background: rgba(59,130,246,0.15); display: none; }
      .toolbar { position: absolute; top: 12px; left: 12px; display: flex; gap: 10px; align-items: flex-start; background: rgba(12,16,26,0.68); border: 1px solid rgba(255,255,255,0.12); border-radius: 10px; padding: 8px 10px; backdrop-filter: blur(6px); pointer-events: auto; }
      .toolbar.right { left: auto; right: 12px; align-items: center; }
      .toolbar .actions { gap: 10px; }
      .empty { padding: 28px 18px; text-align: center; color: var(--muted); }
      .empty code { color: var(--text); }
    </style>
  </head>
  <body>
    <div class="wrap">
      <div class="canvas" id="mount">
        <div class="empty" id="empty">
          Waiting for updates. From your MCP client, call <code>update_browser_view</code> with this viewId.
        </div>
        <div class="toolbar" id="toolbarLeft">
          <div class="meta">
            <div class="brand">Excalichat</div>
            <div class="title" id="title">Excalichat Live View</div>
            <div class="sub">viewId: <code id="viewId"></code> · checkpoint: <code id="checkpoint">(none)</code></div>
            <div class="desc" id="desc" style="display:none"></div>
          </div>
        </div>
        <div class="toolbar right" id="toolbarRight">
          <div class="actions">
            <div class="status" title="connection status">
              <span class="status-dot" id="statusDot" data-state="reconnecting"></span>
              <span id="status">connecting…</span>
            </div>
            <div style="position: relative;">
              <button class="export-btn" id="exportBtn" title="Export">
                <span>Export</span>
                <span aria-hidden="true">⤓</span>
              </button>
              <div class="export-menu" id="exportMenu">
                <button id="exportSvg">Download SVG</button>
                <button id="exportPng">Download PNG</button>
              </div>
            </div>
          </div>
        </div>
        <div class="overlay" id="overlay">
          <div class="selection" id="selection"></div>
        </div>
      </div>
    </div>
    <script type="module">
      import { exportToSvg, convertToExcalidrawElements, FONT_FAMILY } from "https://esm.sh/@excalidraw/excalidraw@0.18.0?deps=react@19.0.0,react-dom@19.0.0";

      const VIEW_ID = ${JSON.stringify(viewId)};
      const INITIAL_META = ${JSON.stringify({ title: meta.title ?? "", description: meta.description ?? "", skin: meta.skin ?? "slate" })};
      const mount = document.getElementById("mount");
      const empty = document.getElementById("empty");
      const overlay = document.getElementById("overlay");
      const selectionEl = document.getElementById("selection");
      const statusEl = document.getElementById("status");
      const statusDot = document.getElementById("statusDot");
      const viewIdEl = document.getElementById("viewId");
      const checkpointEl = document.getElementById("checkpoint");
      const titleEl = document.getElementById("title");
      const descEl = document.getElementById("desc");
      const exportBtn = document.getElementById("exportBtn");
      const exportMenu = document.getElementById("exportMenu");
      const exportSvg = document.getElementById("exportSvg");
      const exportPng = document.getElementById("exportPng");

      let zoom = 1;
      let panX = 0;
      let panY = 0;
      let isPanning = false;
      let panStart = { x: 0, y: 0 };
      let panOrigin = { x: 0, y: 0 };
      let isSelecting = false;
      let selectionActive = false;
      let selectStart = { x: 0, y: 0 };
      let selectRect = { x: 0, y: 0 };
      let selectionBox = { x: 0, y: 0, w: 0, h: 0 };
      let lastViewBox = null;
      viewIdEl.textContent = VIEW_ID;

      function applyMeta(meta) {
        if (!meta) return;
        if (meta.skin) document.body.dataset.skin = meta.skin;
        if (meta.title) titleEl.textContent = meta.title;
        if (meta.description) {
          descEl.textContent = meta.description;
          descEl.style.display = "block";
        }
      }

      applyMeta(INITIAL_META);

      const EXPORT_PADDING = 20;
      const pseudoTypes = new Set(["cameraUpdate", "delete", "restoreCheckpoint"]);

      function convertRawElements(els) {
        const real = els.filter((el) => el && !pseudoTypes.has(el.type));
        const withLabelDefaults = real.map((el) =>
          el && el.label ? { ...el, label: { textAlign: "center", verticalAlign: "middle", ...el.label } } : el
        );
        const converted = convertToExcalidrawElements(withLabelDefaults, { regenerateIds: false })
          .map((el) => el.type === "text" ? { ...el, fontFamily: (FONT_FAMILY?.Excalifont ?? 1) } : el);
        return converted;
      }

      function extractViewport(raw) {
        let vp = null;
        for (const el of raw) {
          if (el && el.type === "cameraUpdate" && el.width && el.height) {
            vp = { x: el.x ?? 0, y: el.y ?? 0, width: el.width, height: el.height };
          }
        }
        return vp;
      }

      function computeSceneMinXY(elements) {
        let minX = Infinity;
        let minY = Infinity;
        for (const el of elements) {
          if (!el || el.x == null || el.y == null) continue;
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
        return { minX: Number.isFinite(minX) ? minX : 0, minY: Number.isFinite(minY) ? minY : 0 };
      }

      async function ensureFontsLoaded() {
        try { await document.fonts.load("20px Excalifont"); } catch {}
      }

      async function render(payload) {
        const raw = Array.isArray(payload?.elements) ? payload.elements : [];
        const vp = extractViewport(raw);
        const excalidrawElements = convertRawElements(raw);

        if (excalidrawElements.length === 0) return;
        await ensureFontsLoaded();

        const svg = await exportToSvg({
          elements: excalidrawElements,
          appState: { viewBackgroundColor: "transparent", exportBackground: false },
          files: null,
          exportPadding: EXPORT_PADDING,
          skipInliningFonts: true,
        });

        svg.style.width = "100%";
        svg.style.height = "100%";
        svg.removeAttribute("width");
        svg.removeAttribute("height");

        if (vp) {
          const { minX, minY } = computeSceneMinXY(excalidrawElements);
          const vbX = vp.x - minX + EXPORT_PADDING;
          const vbY = vp.y - minY + EXPORT_PADDING;
          svg.setAttribute("viewBox", vbX + " " + vbY + " " + vp.width + " " + vp.height);
          lastViewBox = { x: vbX, y: vbY, width: vp.width, height: vp.height };
        } else {
          lastViewBox = null;
        }

        empty?.remove();
        mount.querySelector("svg")?.remove();
        svg.style.transformOrigin = "0 0";
        svg.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
        mount.appendChild(svg);
        cacheExports(svg);
      }

      function setStatus(text) {
        statusEl.textContent = text;
      }

      function setStatusState(state) {
        if (statusDot) statusDot.dataset.state = state;
      }

      function download(url, filename) {
        const a = document.createElement("a");
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }

      async function cacheExports(svgEl) {
        try {
          const serializer = new XMLSerializer();
          const svgText = serializer.serializeToString(svgEl);
          await fetch("/view/" + encodeURIComponent(VIEW_ID) + "/cache", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ svg: svgText }),
          });

          const svgBlob = new Blob([svgText], { type: "image/svg+xml" });
          const url = URL.createObjectURL(svgBlob);
          const img = new Image();
          img.onload = async () => {
            const canvas = document.createElement("canvas");
            canvas.width = img.width;
            canvas.height = img.height;
            const ctx = canvas.getContext("2d");
            if (!ctx) return;
            ctx.drawImage(img, 0, 0);
            canvas.toBlob(async (blob) => {
              if (!blob) return;
              const buf = await blob.arrayBuffer();
              const bytes = new Uint8Array(buf);
              let binary = "";
              for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]);
              const pngBase64 = btoa(binary);
              await fetch("/view/" + encodeURIComponent(VIEW_ID) + "/cache", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({ pngBase64 }),
              });
            }, "image/png");
            URL.revokeObjectURL(url);
          };
          img.src = url;
        } catch {}
      }

      const es = new EventSource("/view/" + encodeURIComponent(VIEW_ID) + "/events");
      es.addEventListener("update", async (e) => {
        try {
          const payload = JSON.parse(e.data);
          if (payload?.checkpointId) checkpointEl.textContent = payload.checkpointId;
          setStatus("connected");
          setStatusState("connected");
          await render(payload);
        } catch {
          setStatus("bad update");
          setStatusState("reconnecting");
        }
      });
      es.addEventListener("meta", (e) => {
        try { applyMeta(JSON.parse(e.data)); } catch {}
      });
      es.addEventListener("closed", () => {
        setStatus("closed");
        setStatusState("closed");
        try { es.close(); } catch {}
      });
      es.onerror = () => { setStatus("reconnecting…"); setStatusState("reconnecting"); };

      function applyTransform() {
        const svg = mount.querySelector("svg");
        if (!svg) return;
        svg.style.transformOrigin = "0 0";
        svg.style.transform = "translate(" + panX + "px, " + panY + "px) scale(" + zoom + ")";
      }

      function clampZoom(z) {
        return Math.max(0.2, Math.min(4, z));
      }

      function updateSelectionBox() {
        if (!selectionEl) return;
        if (!selectionActive && !isSelecting) {
          selectionEl.style.display = "none";
          return;
        }
        const x = isSelecting ? Math.min(selectStart.x, selectRect.x) : selectionBox.x;
        const y = isSelecting ? Math.min(selectStart.y, selectRect.y) : selectionBox.y;
        const w = isSelecting ? Math.abs(selectRect.x - selectStart.x) : selectionBox.w;
        const h = isSelecting ? Math.abs(selectRect.y - selectStart.y) : selectionBox.h;
        selectionEl.style.display = "block";
        selectionEl.style.left = x + "px";
        selectionEl.style.top = y + "px";
        selectionEl.style.width = w + "px";
        selectionEl.style.height = h + "px";
      }

      function clearSelection() {
        selectionActive = false;
        updateSelectionBox();
      }

      function clientToCanvas(evt) {
        const rect = mount.getBoundingClientRect();
        return { x: evt.clientX - rect.left, y: evt.clientY - rect.top };
      }

      function canvasToViewBox(x, y) {
        if (!lastViewBox) return null;
        return {
          x: lastViewBox.x + (x - panX) / zoom,
          y: lastViewBox.y + (y - panY) / zoom,
        };
      }

      async function sendSelection() {
        if (!lastViewBox || !selectionEl) return;
        const x1 = Math.min(selectStart.x, selectRect.x);
        const y1 = Math.min(selectStart.y, selectRect.y);
        const x2 = Math.max(selectStart.x, selectRect.x);
        const y2 = Math.max(selectStart.y, selectRect.y);
        if (Math.abs(x2 - x1) < 4 || Math.abs(y2 - y1) < 4) return;

        const p1 = canvasToViewBox(x1, y1);
        const p2 = canvasToViewBox(x2, y2);
        if (!p1 || !p2) return;

        const bounds = {
          x: Math.min(p1.x, p2.x),
          y: Math.min(p1.y, p2.y),
          width: Math.abs(p2.x - p1.x),
          height: Math.abs(p2.y - p1.y),
          viewBox: lastViewBox,
        };

        await fetch("/view/" + encodeURIComponent(VIEW_ID) + "/selection", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ bounds }),
        });
      }

      mount.addEventListener("wheel", (e) => {
        e.preventDefault();
        const delta = Math.sign(e.deltaY);
        const rect = mount.getBoundingClientRect();
        const cx = e.clientX - rect.left;
        const cy = e.clientY - rect.top;
        const prevZoom = zoom;
        zoom = clampZoom(zoom * (delta > 0 ? 0.9 : 1.1));
        panX = cx - ((cx - panX) * (zoom / prevZoom));
        panY = cy - ((cy - panY) * (zoom / prevZoom));
        applyTransform();
      }, { passive: false });

      mount.addEventListener("pointerdown", (e) => {
        if (e.button === 1 || e.spaceKey || e.altKey) {
          isPanning = true;
          panStart = { x: e.clientX, y: e.clientY };
          panOrigin = { x: panX, y: panY };
          mount.setPointerCapture(e.pointerId);
          return;
        }
        if (e.shiftKey) {
          isSelecting = true;
          selectionActive = true;
          const p = clientToCanvas(e);
          selectStart = p;
          selectRect = p;
          updateSelectionBox();
          mount.setPointerCapture(e.pointerId);
          return;
        }
        if (selectionActive) {
          clearSelection();
        }
      });

      mount.addEventListener("pointermove", (e) => {
        if (isPanning) {
          panX = panOrigin.x + (e.clientX - panStart.x);
          panY = panOrigin.y + (e.clientY - panStart.y);
          applyTransform();
        }
        if (isSelecting) {
          selectRect = clientToCanvas(e);
          updateSelectionBox();
        }
      });

      mount.addEventListener("pointerup", async (e) => {
        if (isPanning) {
          isPanning = false;
          mount.releasePointerCapture(e.pointerId);
        }
        if (isSelecting) {
          isSelecting = false;
          const x = Math.min(selectStart.x, selectRect.x);
          const y = Math.min(selectStart.y, selectRect.y);
          const w = Math.abs(selectRect.x - selectStart.x);
          const h = Math.abs(selectRect.y - selectStart.y);
          selectionBox = { x, y, w, h };
          updateSelectionBox();
          await sendSelection();
          mount.releasePointerCapture(e.pointerId);
        }
      });

      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") clearSelection();
      });

      exportBtn?.addEventListener("click", (e) => {
        e.preventDefault();
        const open = exportMenu?.dataset.open === "true";
        if (exportMenu) exportMenu.dataset.open = open ? "false" : "true";
      });

      document.addEventListener("click", (e) => {
        if (!exportMenu || !exportBtn) return;
        if (exportMenu.contains(e.target) || exportBtn.contains(e.target)) return;
        exportMenu.dataset.open = "false";
      });

      exportSvg?.addEventListener("click", () => {
        exportMenu.dataset.open = "false";
        download("/view/" + encodeURIComponent(VIEW_ID) + "/export.svg", "excalichat-" + VIEW_ID + ".svg");
      });

      exportPng?.addEventListener("click", () => {
        exportMenu.dataset.open = "false";
        download("/view/" + encodeURIComponent(VIEW_ID) + "/export.png", "excalichat-" + VIEW_ID + ".png");
      });
    </script>
  </body>
</html>`;
}

async function startMcpHttpServer(
  createServer: () => McpServer,
  port: number,
): Promise<import("node:http").Server> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());

  app.all("/mcp", async (req: Request, res: Response) => {
    const server = createServer();
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined,
    });

    res.on("close", () => {
      transport.close().catch(() => {});
      server.close().catch(() => {});
    });

    try {
      await server.connect(transport);
      await transport.handleRequest(req, res, req.body);
    } catch (error) {
      console.error("MCP error:", error);
      if (!res.headersSent) {
        res.status(500).json({
          jsonrpc: "2.0",
          error: { code: -32603, message: "Internal server error" },
          id: null,
        });
      }
    }
  });

  return await new Promise((resolve, reject) => {
    const httpServer = app.listen(port, (err) => {
      if (err) return reject(err);
      console.log(`Excalichat MCP server listening on http://localhost:${port}/mcp`);
      resolve(httpServer);
    });
  });
}

async function startViewerServer(
  liveViews: LiveViewHubWithState,
  store: FileCheckpointStore,
  port: number,
): Promise<{ server: import("node:http").Server; port: number; baseUrl: string }> {
  const app = createMcpExpressApp({ host: "0.0.0.0" });
  app.use(cors());
  app.use(express.json({ limit: "10mb" }));

  app.get("/view/:viewId", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    if (!liveViews.hasView(viewId)) {
      res.status(404).type("text/plain").send(`Unknown view id: "${viewId}". Create one via create_browser_view.`);
      return;
    }
    const meta = liveViews._views.get(viewId);
    res
      .status(200)
      .type("text/html")
      .setHeader("Content-Security-Policy", browserViewCsp())
      .setHeader("Cache-Control", "no-store")
      .send(browserViewHtml(viewId, {
        title: meta?.title,
        description: meta?.description,
        skin: meta?.skin,
      }));
  });

  app.get("/view/:viewId/events", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    if (!liveViews.hasView(viewId)) {
      res.status(404).type("text/plain").send(`Unknown view id: "${viewId}".`);
      return;
    }

    const state = liveViews._views.get(viewId);
    if (!state) {
      res.status(404).type("text/plain").send(`Unknown view id: "${viewId}".`);
      return;
    }

    res.status(200);
    res.setHeader("Content-Type", "text/event-stream");
    res.setHeader("Cache-Control", "no-cache, no-transform");
    res.setHeader("Connection", "keep-alive");
    res.setHeader("X-Accel-Buffering", "no");
    res.flushHeaders?.();

    const ping = setInterval(() => {
      try { res.write(": ping\n\n"); } catch {}
    }, 20_000);

    state.clients.add(res);
    if (state.lastPayload) {
      sseWrite(res, "update", state.lastPayload);
    } else if (state.lastCheckpointId) {
      store.load(state.lastCheckpointId)
        .then((cp) => {
          if (!cp?.elements) return;
          const payload = { elements: cp.elements, checkpointId: state.lastCheckpointId };
          state.lastPayload = payload;
          sseWrite(res, "update", payload);
        })
        .catch(() => {});
    }

    req.on("close", () => {
      clearInterval(ping);
      state.clients.delete(res);
    });
  });

  app.post("/view/:viewId/cache", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    const state = liveViews._views.get(viewId);
    if (!state) {
      res.status(404).type("text/plain").send(`Unknown view id: "${viewId}".`);
      return;
    }
    const { svg, pngBase64 } = req.body ?? {};
    if (typeof svg === "string") state.lastSvg = svg;
    if (typeof pngBase64 === "string") {
      try { state.lastPng = Buffer.from(pngBase64, "base64"); } catch {}
    }
    res.status(204).end();
  });

  app.post("/view/:viewId/selection", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    const state = liveViews._views.get(viewId);
    if (!state) {
      res.status(404).type("text/plain").send(`Unknown view id: "${viewId}".`);
      return;
    }
    const { bounds, pngBase64 } = req.body ?? {};
    if (bounds && typeof bounds === "object") {
      const selection = {
        bounds,
        pngBase64: typeof pngBase64 === "string" ? pngBase64 : undefined,
        updatedAt: new Date().toISOString(),
      };
      state.lastSelection = selection;
      liveViews.setSelection(viewId, selection);
    }
    res.status(204).end();
  });

  app.get("/view/:viewId/export.svg", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    const state = liveViews._views.get(viewId);
    if (!state?.lastSvg) {
      res.status(404).type("text/plain").send(`No SVG cached for view id: "${viewId}".`);
      return;
    }
    res
      .status(200)
      .setHeader("Content-Type", "image/svg+xml; charset=utf-8")
      .setHeader("Content-Disposition", `attachment; filename=excalichat-${viewId}.svg`)
      .send(state.lastSvg);
  });

  app.get("/view/:viewId/export.png", (req: Request, res: Response) => {
    const viewId = String(req.params.viewId ?? "");
    const state = liveViews._views.get(viewId);
    if (!state?.lastPng) {
      res.status(404).type("text/plain").send(`No PNG cached for view id: "${viewId}".`);
      return;
    }
    res
      .status(200)
      .setHeader("Content-Type", "image/png")
      .setHeader("Content-Disposition", `attachment; filename=excalichat-${viewId}.png`)
      .send(state.lastPng);
  });

  const server = await new Promise<import("node:http").Server>((resolve, reject) => {
    const s = app.listen(port, (err) => {
      if (err) return reject(err);
      resolve(s);
    });
  });

  const address = server.address();
  const actualPort = typeof address === "object" && address ? address.port : port;
  const baseUrl = process.env.VIEWER_BASE_URL ?? `http://localhost:${actualPort}`;
  liveViews.setBaseUrl(baseUrl);

  console.log(`Excalichat viewer listening on ${baseUrl}`);
  return { server, port: actualPort, baseUrl };
}

export async function startStdioServer(
  createServer: () => McpServer,
): Promise<void> {
  await createServer().connect(new StdioServerTransport());
}

async function main() {
  const store = new FileCheckpointStore();
  const liveViews = createLiveViewHub("http://localhost:0");
  const factory = () => createServerWithLiveViews(store, liveViews);

  const viewerPort = parseInt(process.env.VIEWER_PORT ?? "0", 10);
  const viewer = await startViewerServer(liveViews, store, viewerPort);

  const shutdown = () => {
    console.log("\nShutting down...");
    viewer.server.close(() => {});
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  if (process.argv.includes("--stdio")) {
    await startStdioServer(factory);
  } else {
    const port = parseInt(process.env.PORT ?? "3001", 10);
    await startMcpHttpServer(factory, port);
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
