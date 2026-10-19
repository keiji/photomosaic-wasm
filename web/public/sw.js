/**
 * Service Worker(オフラインキャッシュ)。
 *
 * 基本設計書 5 章 / handoff/02: 初回アクセスで静的アセット(index.html と
 * ビルド成果物、WASM バイナリを含む)を取得したのちは、ネットワーク断でも
 * 動作する(2 回目以降は完全オフライン)。
 *
 * 戦略: cache-first(ビルド成果物のファイル名にハッシュを含み、内容変更で
 * URL が変わるため、古いハッシュ asset のキャッシュは古いだけ)。
 * バイパス: 生成物以外のページ遷移(HTML は 2 枚)はネットワーク先行で
 * 更新しつつ、取得できない場合にキャッシュへフォールバックする。
 */
const CACHE_NAME = 'photomosaic-offline-v3';

/** GitHub Pages のプロジェクトページ配下でも動くよう、scope 基準で解決する */
const INDEX_PATH = new URL('index.html', self.registration.scope).pathname;

/** install 時に既知の固定ページを先に載せる(2 回目以降の完全オフライン) */
self.addEventListener('install', (event) => {
  event.waitUntil(
    caches
      .open(CACHE_NAME)
      .then((cache) => cache.addAll(['./', './index.html', './index_js.html']))
      .then(() => self.skipWaiting()),
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key))),
      )
      .then(() => self.clients.claim()),
  );
});

self.addEventListener('fetch', (event) => {
  const request = event.request;
  if (request.method !== 'GET') {
    return;
  }
  const url = new URL(request.url);
  if (url.origin !== self.location.origin) {
    return; // クロスオリジン(第三者 CDN 等)は素通し
  }

  // 同一オリジン: キャッシュ優先で応答し、無ければ取得してキャッシュに積む。
  // ビルド成果物(assets/*)は内容ハッシュの URL なので cache-first で安全。
  // index.html(ルート)のみ、ネットワーク先行・失敗時キャッシュで更新性を確保する
  const isHtml =
    request.mode === 'navigate' ||
    request.destination === 'document' ||
    url.pathname === INDEX_PATH;
  event.respondWith(
    (async () => {
      if (isHtml) {
        try {
          const response = await fetch(request);
          const cache = await caches.open(CACHE_NAME);
          cache.put(request, response.clone());
          return response;
        } catch (error) {
          const cached = await caches.match(request);
          if (cached) {
            return cached;
          }
          throw error;
        }
      }
      const cached = await caches.match(request);
      if (cached) {
        return cached;
      }
      const response = await fetch(request);
      if (response.ok) {
        const cache = await caches.open(CACHE_NAME);
        cache.put(request, response.clone());
      }
      return response;
    })(),
  );
});
