#!/usr/bin/env node
/**
 * JS / WASM のメモリフットプリント比較ベンチマーク。
 *
 * - `web/dist` を COOP/COEP 付きでローカル配信する
 * - ヘッドレス Chrome を起動し、WASM 版と JS 版で同じ画像・タイルを生成する
 * - 生成完了後に `performance.measureUserAgentSpecificMemory()` を複数回実行する
 *
 * 前提:
 *   cd web && npm run build
 *
 * 使い方:
 *   node tools/memory-benchmark.mjs \
 *     --main /path/to/main.png \
 *     --tiles /path/to/tiles \
 *     --tile-limit 1000
 *
 * 注意:
 * - `performance.measureUserAgentSpecificMemory()` は Chromium 系かつ
 *   cross-origin isolation (COOP/COEP) が必要。このスクリプトはローカル配信で
 *   ヘッダを付与する。
 * - 結果はページの JS/Worker/DOM/Canvas の概算であり、GPU・コンポジタ・
 *   ブラウザプロセス全体の RSS ではない。
 */
import { spawn } from "node:child_process";
import {
  existsSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { extname, join, normalize } from "node:path";
import { createReadStream } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { parseArgs } from "node:util";

const BASE_PATH = "/photomosaic-wasm/";
const DIST_DIR = new URL("../web/dist/", import.meta.url).pathname;

const MIME_TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".svg": "image/svg+xml",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json",
  ".ico": "image/x-icon",
};

function usage() {
  console.log(`Usage:
  node tools/memory-benchmark.mjs --main <main.png> --tiles <tile-dir> [options]

Options:
  --main <path>          Main image (required)
  --tiles <dir>          Directory containing tile images (required)
  --tile-pattern <prefix> Tile filename prefix (default: tile)
  --tile-limit <n>       Maximum number of tiles (default: all)
  --samples <n>          UAM samples per snapshot (default: 3)
  --out <path>           Write JSON result to a file
  --chrome <path>        Chrome/Chromium binary (default: auto-detect / CHROME_BIN)
  --help                 Show this help
`);
}

const { values: args } = parseArgs({
  options: {
    main: { type: "string" },
    tiles: { type: "string" },
    "tile-pattern": { type: "string", default: "tile" },
    "tile-limit": { type: "string" },
    samples: { type: "string", default: "3" },
    out: { type: "string" },
    chrome: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (args.help) {
  usage();
  process.exit(0);
}
if (!args.main || !args.tiles) {
  usage();
  throw new Error("--main and --tiles are required");
}
if (!existsSync(DIST_DIR)) {
  throw new Error(
    `web/dist not found: ${DIST_DIR}. Run "cd web && npm run build" first.`,
  );
}
if (!existsSync(args.main)) {
  throw new Error(`main image not found: ${args.main}`);
}
if (!statSync(args.tiles).isDirectory()) {
  throw new Error(`tiles path is not a directory: ${args.tiles}`);
}

const sampleCount = Math.max(1, Number.parseInt(args.samples, 10));
const tileLimit = args["tile-limit"]
  ? Number.parseInt(args["tile-limit"], 10)
  : Infinity;
const tileFiles = readdirSync(args.tiles)
  .filter((name) => name.startsWith(args["tile-pattern"]))
  .sort()
  .slice(0, tileLimit)
  .map((name) => join(args.tiles, name));
if (tileFiles.length === 0) {
  throw new Error(
    `no tile images found in ${args.tiles} with prefix ${args["tile-pattern"]}`,
  );
}

function findChrome() {
  const candidates = [
    args.chrome,
    process.env.CHROME_BIN,
    "/opt/google/chrome/chrome",
    "/usr/bin/google-chrome",
    "/usr/bin/google-chrome-stable",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
  ].filter(Boolean);
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error(
    "Chrome/Chromium not found. Set CHROME_BIN or pass --chrome.",
  );
}

function startServer() {
  const server = createServer((req, res) => {
    let pathname = new URL(req.url, "http://localhost").pathname;
    if (pathname === BASE_PATH.slice(0, -1)) {
      res.writeHead(302, { location: BASE_PATH });
      res.end();
      return;
    }
    if (!pathname.startsWith(BASE_PATH)) {
      res.writeHead(404);
      res.end("not found");
      return;
    }
    pathname = pathname.slice(BASE_PATH.length);
    if (pathname === "" || pathname.endsWith("/")) pathname += "index.html";
    const filePath = normalize(join(DIST_DIR, pathname));
    if (!filePath.startsWith(DIST_DIR)) {
      res.writeHead(403);
      res.end("forbidden");
      return;
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      res.writeHead(200, {
        "content-type":
          MIME_TYPES[extname(filePath)] ?? "application/octet-stream",
        "content-length": stat.size,
        "cross-origin-opener-policy": "same-origin",
        "cross-origin-embedder-policy": "require-corp",
        "cross-origin-resource-policy": "same-origin",
        "cache-control": "no-store",
      });
      createReadStream(filePath).pipe(res);
    } catch {
      res.writeHead(404);
      res.end("not found");
    }
  });
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function getDebugPort() {
  const server = createServer();
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = server.address().port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

async function waitForDebugEndpoint(port, timeoutMs = 15000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`);
      if (response.ok) return;
    } catch {
      // not ready
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("timed out waiting for Chrome remote debugging endpoint");
}

class CdpClient {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.nextId = 1;
    this.pending = new Map();
    this.ws.addEventListener("message", (event) => {
      const message = JSON.parse(event.data);
      if (!message.id) return;
      const entry = this.pending.get(message.id);
      if (!entry) return;
      this.pending.delete(message.id);
      if (message.error) entry.reject(new Error(message.error.message));
      else entry.resolve(message.result);
    });
  }

  async connect() {
    await new Promise((resolve, reject) => {
      this.ws.addEventListener("open", resolve, { once: true });
      this.ws.addEventListener("error", reject, { once: true });
    });
  }

  send(method, params = {}) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  close() {
    this.ws.close();
  }
}

async function createPageClient(debugPort) {
  const targets = await fetch(`http://127.0.0.1:${debugPort}/json`).then((r) =>
    r.json(),
  );
  const pageTarget = targets.find((target) => target.type === "page");
  if (!pageTarget) throw new Error("page target not found");
  const cdp = new CdpClient(pageTarget.webSocketDebuggerUrl);
  await cdp.connect();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("DOM.enable");
  await cdp.send("Network.enable");
  await cdp.send("Network.setCacheDisabled", { cacheDisabled: true });
  return cdp;
}

async function evaluate(cdp, expression) {
  const result = await cdp.send("Runtime.evaluate", {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    throw new Error(result.exceptionDetails.text);
  }
  return result.result.value;
}

async function waitFor(cdp, expression, timeoutMs, label) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (await evaluate(cdp, expression)) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(`timeout waiting for ${label}`);
}

async function setFiles(cdp, selector, files) {
  const root = await cdp.send("DOM.getDocument", { depth: -1, pierce: true });
  const node = await cdp.send("DOM.querySelector", {
    nodeId: root.root.nodeId,
    selector,
  });
  if (!node.nodeId) throw new Error(`file input not found: ${selector}`);
  await cdp.send("DOM.setFileInputFiles", { nodeId: node.nodeId, files });
}

async function measureUam(cdp, samples) {
  return evaluate(
    cdp,
    `
    (async () => {
      if (typeof performance.measureUserAgentSpecificMemory !== 'function') {
        throw new Error('performance.measureUserAgentSpecificMemory is not available');
      }
      if (!self.crossOriginIsolated) {
        throw new Error('crossOriginIsolated is false; COOP/COEP headers are required');
      }
      const values = [];
      for (let i = 0; i < ${samples}; i++) {
        await new Promise((resolve) => setTimeout(resolve, 200));
        values.push(await performance.measureUserAgentSpecificMemory());
      }
      return values;
    })()
  `,
  );
}

function summarizeUam(samples) {
  const sorted = [...samples].sort((a, b) => a.bytes - b.bytes);
  const median = sorted[Math.floor(sorted.length / 2)];
  return {
    medianBytes: median.bytes,
    medianBreakdown: median.breakdown,
    samples: samples.map((sample) => ({
      bytes: sample.bytes,
      breakdown: sample.breakdown,
    })),
  };
}

async function runPage({ cdp, pageUrl, label, mainFile, tileFiles }) {
  await cdp.send("Page.navigate", { url: pageUrl });
  await waitFor(
    cdp,
    'document.readyState === "complete"',
    15000,
    `${label} page load`,
  );
  await waitFor(
    cdp,
    '!document.querySelector("#screen-start").hidden',
    15000,
    `${label} start screen`,
  );

  await waitFor(
    cdp,
    `document.querySelector('#main-drop-zone + input[type="file"]') !== null`,
    30000,
    `${label} main file input`,
  );
  await setFiles(cdp, '#main-drop-zone + input[type="file"]', [mainFile]);
  await waitFor(
    cdp,
    '!document.querySelector("#screen-edit").hidden',
    15000,
    `${label} main loaded`,
  );

  await waitFor(
    cdp,
    `document.querySelector('#tile-drop-zone + input[type="file"]') !== null`,
    30000,
    `${label} tile file input`,
  );
  await setFiles(cdp, '#tile-drop-zone + input[type="file"]', tileFiles);
  await waitFor(
    cdp,
    `document.querySelector("#tile-summary").textContent.replace(/[^0-9]/g, "").includes("${tileFiles.length}")`,
    300000,
    `${label} tiles loaded`,
  );
  await waitFor(
    cdp,
    '!document.querySelector("#generate-button").disabled',
    30000,
    `${label} generate enabled`,
  );

  const baseline = summarizeUam(await measureUam(cdp, sampleCount));

  await evaluate(cdp, 'document.querySelector("#generate-button").click()');
  await waitFor(
    cdp,
    'document.querySelector("#phase-label").textContent === "合成終了"',
    180000,
    `${label} generation finished`,
  );

  const retained = summarizeUam(await measureUam(cdp, sampleCount));
  const result = await evaluate(
    cdp,
    `
    (() => {
      const canvas = document.querySelector('#preview-canvas');
      const ctx = canvas.getContext('2d');
      const data = ctx.getImageData(0, 0, canvas.width, canvas.height).data;
      let sum = 0;
      for (let i = 0; i < data.length; i += 997) sum = (sum + data[i]) % 1000000007;
      return {
        phase: document.querySelector('#phase-label').textContent,
        tileSummary: document.querySelector('#tile-summary').textContent,
        tileMemory: document.querySelector('#tile-memory')?.textContent ?? null,
        canvas: { width: canvas.width, height: canvas.height, sum },
        metrics: document.querySelector('#metrics-overlay')?.textContent ?? null,
      };
    })()
  `,
  );

  return { label, pageUrl, baseline, retained, result };
}

const chromeBin = findChrome();
const server = await startServer();
const serverPort = server.address().port;
const debugPort = await getDebugPort();
const userDataDir = await mkdtemp(join(tmpdir(), "photomosaic-memory-"));
const chrome = spawn(
  chromeBin,
  [
    "--headless=new",
    "--no-sandbox",
    "--disable-gpu",
    `--remote-debugging-port=${debugPort}`,
    `--user-data-dir=${userDataDir}`,
    "about:blank",
  ],
  { stdio: "ignore" },
);

let cdp;
try {
  await waitForDebugEndpoint(debugPort);
  cdp = await createPageClient(debugPort);
  const baseUrl = `http://127.0.0.1:${serverPort}${BASE_PATH}`;
  const runs = [];
  runs.push(
    await runPage({
      cdp,
      pageUrl: baseUrl,
      label: "wasm",
      mainFile: args.main,
      tileFiles,
    }),
  );
  await cdp.send("Page.navigate", { url: "about:blank" });
  await new Promise((resolve) => setTimeout(resolve, 500));
  runs.push(
    await runPage({
      cdp,
      pageUrl: `${baseUrl}index_js.html`,
      label: "js",
      mainFile: args.main,
      tileFiles,
    }),
  );

  const output = {
    generatedAt: new Date().toISOString(),
    chrome: chromeBin,
    workload: {
      mainFile: args.main,
      tileDir: args.tiles,
      tileCount: tileFiles.length,
      samples: sampleCount,
    },
    runs,
  };
  const json = JSON.stringify(output, null, 2);
  console.log(json);
  if (args.out) {
    writeFileSync(args.out, `${json}\n`);
  }
} finally {
  cdp?.close();
  chrome.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  server.close();
  rmSync(userDataDir, { recursive: true, force: true });
}
