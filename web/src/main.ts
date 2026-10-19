/**
 * エントリポイント。状態遷移と UI・モックコアの結線を行う。
 *
 * M7 のデモフロー(handoff/04: 性能と強健性):
 *   - メトリクスオーバーレイ(開発ビルド限定)でコアのフェーズ・バッチ所要を常時表示
 *   - Service Worker による完全オフライン化(本番ビルド)
 *   - メモリガード超過時のサムネイル自動縮小への追従
 *   - 巨大画像(長辺 4096px 超)は自動縮小して読み込む旨を案内
 *
 * M6 のデモフロー(handoff/04: インタラクティブ化):
 *   S2 でのブロックサイズ変更・タイル追加/削除に生成処理が自動で追随する。
 *   - ブロックサイズ変更: デバウンス(300ms)後、P2 スキップのフル再マッチで再生成
 *   - タイル追加: 差分再マッチ(未確定ブロック優先 or 差し替え評価)
 *   - タイル削除: 該当ブロックの再マッチ
 *   - 実行中の変更は要求の合流(詳細設計書 7.5)でバッチ境界の
 *     キャンセル後に最新状態で再開する
 */
import './style.css';
import { InvalidFileError, loadMainImage, loadTile } from './io/imageLoader';
import { buildDownloadFilename, downloadBlob, encodePng } from './io/exporter';
import { createCoreBridge, getCoreImplementation } from './core/bridge';
import type { GridInfo } from './core/types';
import { AppStore } from './state/store';
import type { AppStoreData } from './state/store';
import { messages, phaseLabelFor } from './i18n/messages';
import { setupFileZone } from './ui/dropZone';
import { Preview } from './ui/preview';
import { ProgressPanel } from './ui/progress';
import { Controls } from './ui/controls';
import { TileList } from './ui/tileList';
import { MetricsOverlay } from './ui/metricsOverlay';

/** Service Worker の登録(オフライン化: 本番ビルドのみ。開発中のモジュール
 * キャッシュ汚染を避ける)。失敗してもアプリはオンラインで動く */
function registerServiceWorker(): void {
  if (import.meta.env.PROD && 'serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw.js').catch((err) => {
      console.warn('service worker registration failed', err);
    });
  }
}

/** タイル追加処理の 1 バッチあたりの枚数(バッチ間で UI に制御を返す) */
const TILE_BATCH_SIZE = 8;

function requireElement<T extends HTMLElement>(selector: string): T {
  const el = document.querySelector<T>(selector);
  if (!el) {
    throw new Error(`element not found: ${selector}`);
  }
  return el;
}

function applyMessages(): void {
  requireElement<HTMLElement>('#app-title').textContent = messages.appTitle;
  requireElement<HTMLElement>('#offline-badge').textContent = messages.offlineBadge;
  requireElement<HTMLElement>('#main-drop-hint').textContent = messages.mainDropHint;
  requireElement<HTMLElement>('#tile-heading').textContent = messages.tileHeading;
  requireElement<HTMLElement>('#tile-drop-hint').textContent = messages.tileDropHint;
  requireElement<HTMLElement>('#privacy-notice').textContent = messages.privacyNotice;
  requireElement<HTMLElement>('#edit-heading').textContent = messages.editTitle;
  requireElement<HTMLElement>('#back-button').textContent = messages.back;
  requireElement<HTMLElement>('#save-button').textContent = messages.save;
  requireElement<HTMLElement>('#block-size-label').textContent = messages.blockSizeLabel;
  requireElement<HTMLElement>('#tile-drop-hint-edit').textContent = messages.tileDropHintEdit;
  requireElement<HTMLButtonElement>('#generate-button').textContent = messages.generate;
  requireElement<HTMLButtonElement>('#cancel-button').textContent = messages.cancel;
  requireElement<HTMLElement>('#tiles-required-hint').textContent = messages.tilesRequiredHint;
  requireElement<HTMLElement>('#main-blend-label').textContent = messages.mainBlendLabel;
  requireElement<HTMLElement>('#preview-hint').textContent = messages.previewDropHint;
  requireElement<HTMLDivElement>('#preview-frame').setAttribute(
    'aria-label',
    messages.previewChangeLabel,
  );
  requireElement<HTMLCanvasElement>('#preview-canvas').setAttribute(
    'aria-label',
    messages.previewAriaLabel,
  );
}

async function main(): Promise<void> {
  applyMessages();
  registerServiceWorker();

  const store = new AppStore();
  const core = await createCoreBridge();
  const coreVersion = await core.getVersion();
  // コアバージョンの表示(handoff/02: UI とコアの不整合検知)
  console.info(`photomosaic core: ${coreVersion} (impl: ${getCoreImplementation()})`);
  // メトリクスオーバーレイ(M7: handoff/05 §6。本番ビルドでは実体なし)
  const metricsOverlay = new MetricsOverlay(document);

  const screenStart = requireElement<HTMLElement>('#screen-start');
  const screenEdit = requireElement<HTMLElement>('#screen-edit');
  const errorNotice = requireElement<HTMLElement>('#error-notice');
  const tileSummary = requireElement<HTMLElement>('#tile-summary');
  const tileMemory = requireElement<HTMLElement>('#tile-memory');
  const tilesReadyHint = requireElement<HTMLElement>('#tiles-ready-hint');
  const tilesRequiredHint = requireElement<HTMLElement>('#tiles-required-hint');
  const tileListStartContainer = requireElement<HTMLElement>('#tile-list-start');
  const tileListEditContainer = requireElement<HTMLElement>('#tile-list-edit');

  const preview = new Preview(requireElement<HTMLCanvasElement>('#preview-canvas'));
  const progress = new ProgressPanel(requireElement<HTMLElement>('#progress-section'));
  const controls = new Controls(screenEdit);

  // 直近のグリッド情報(メイン画像解析・ブロックサイズ変更の戻り値。
  // 生成開始時のプレビュー再描画に使用する)
  let currentGrid: GridInfo | null = null;

  // --- 進捗イベントの受信(M5: コア駆動・スロットリング済み) ---
  core.onProgress((event) => {
    progress.setCounts(event.assignedBlocks, event.totalBlocks);
    progress.setPhase(phaseLabelFor(event.phaseCode));
    // ストアの進捗も同期させる(render 経由で進捗表示が一貫する)
    store.setBlockCounts(event.totalBlocks, event.assignedBlocks);
  });

  // --- 部分結果の受信(M5: 行バッチ単位の逐次転写) ---
  core.onResult((batch) => {
    preview.drawResultBatch(batch);
  });

  const showError = (message: string): void => {
    errorNotice.textContent = message;
    errorNotice.hidden = false;
  };

  const clearError = (): void => {
    errorNotice.hidden = true;
    errorNotice.textContent = '';
  };

  // --- 状態に応じた画面表示の切替 ---
  const render = (data: AppStoreData): void => {
    const inEdit =
      data.state === 'MAIN_READY' || data.state === 'GENERATING' || data.state === 'DONE';
    screenStart.hidden = inEdit;
    screenEdit.hidden = !inEdit;

    // 保存ボタン: 本仕様どおり DONE でのみ有効(基本設計書 1.4)。
    // M0 の暫定(プレビュー中で有効)から M4 で収束させた
    controls.setSaveEnabled(data.state === 'DONE');

    // 生成ボタン: MAIN_READY / DONE で有効。GENERATING 中は無効。
    // タイルが 0 枚なら案内を表示して無効化(基本設計書 4 章)
    const canGenerate =
      (data.state === 'MAIN_READY' || data.state === 'DONE') && data.tileCount > 0;
    controls.setGenerateEnabled(canGenerate);
    tilesRequiredHint.hidden = !inEdit || data.tileCount > 0;

    // キャンセルボタン: 生成処理中のみ表示(M5)
    controls.setCancelVisible(data.state === 'GENERATING');

    // タイル一覧は S1(TILES_READY 含む)/S2 の両方で操作できるよう表示位置を移動する
    tileList.attachTo(inEdit ? tileListEditContainer : tileListStartContainer);

    tileSummary.textContent = messages.tileSummary(data.tileCount);
    tileMemory.textContent = messages.tileMemoryLabel(data.tilesBytes);

    // TILES_READY: 構成画像のみ設定済み → メイン画像の設定を案内する(基本設計書 1.4)
    tilesReadyHint.hidden = data.state !== 'TILES_READY';

    if (inEdit) {
      progress.setCounts(data.assignedBlocks, data.totalBlocks ?? 0);
    }
  };
  store.subscribe(render);

  // --- S1: メイン画像の受け付け(ファイル検証 → デコード → 正規化 → コア設定) ---
  setupFileZone(requireElement<HTMLElement>('#main-drop-zone'), {
    multiple: false,
    onFiles: async (files) => {
      const file = files[0];
      if (!file) return;
      clearError();
      progress.setPhase(messages.phaseLoadMain);
      try {
        const image = await loadMainImage(file);
        // 巨大画像ガイド(M7): 長辺上限を超えた自動縮小を案内する
        if (image.scaled) {
          showError(messages.mainShrunkNotice(4096));
        }
        const grid = await core.setMainImage(image);
        store.dispatch({ type: 'MAIN_IMAGE_SET' });
        store.setBlockCounts(grid.totalBlocks, 0);
        currentGrid = grid;
        // プレビューはコア算出のブロック平均色(P1 特徴量)で描画する
        preview.drawGrid(grid, core.getBlockMeanColors());
        progress.setPhase(messages.phaseMainAnalyze);
        // TILES_READY からメイン画像を設定すると自動開始(基本設計書 1.4)
        if (store.getData().state === 'GENERATING') {
          await startGeneration();
        }
      } catch (err) {
        if (err instanceof InvalidFileError) {
          showError(messages.errorInvalidFile);
        } else {
          showError(messages.errorLoadFailed);
        }
        progress.reset();
      }
    },
  });

  // --- S2: プレビューへのドロップ/クリックでメイン画像を変更する(基本設計書 3.3) ---
  // 全処理をリセットしてやり直す(タイルプールは維持)。構成画像があれば
  // ブロックサイズ変更と同じく自動でフル再生成する
  setupFileZone(requireElement<HTMLElement>('#preview-frame'), {
    multiple: false,
    onFiles: async (files) => {
      const file = files[0];
      if (!file) return;
      clearError();
      // 実行中の生成は要求の合流(詳細設計書 7.5)で停止してから差し替える
      generation += 1;
      core.cancel();
      progress.setPhase(messages.phaseLoadMain);
      try {
        const image = await loadMainImage(file);
        if (image.scaled) {
          showError(messages.mainShrunkNotice(4096));
        }
        const grid = await core.setMainImage(image);
        store.dispatch({ type: 'MAIN_IMAGE_SET' });
        store.setBlockCounts(grid.totalBlocks, 0);
        currentGrid = grid;
        preview.drawGrid(grid, core.getBlockMeanColors());
        progress.setPhase(messages.phaseMainAnalyze);
        if (store.getData().tileCount > 0) {
          store.dispatch({ type: 'GENERATION_STARTED' });
          progress.setCounts(0, grid.totalBlocks);
          await executeRun('full');
        }
      } catch (err) {
        if (err instanceof InvalidFileError) {
          showError(messages.errorInvalidFile);
        } else {
          showError(messages.errorLoadFailed);
        }
        progress.reset();
      }
    },
  });

  // --- タイル一覧(サムネイル + 個別削除。S1/S2 で表示位置を移動する) ---
  // タイル ID はアプリ側採番(コア API の u64 に対応し bigint を用いる)
  let nextTileId = 0n;
  const tileUrls = new Map<bigint, string>();
  const tileList = new TileList(tileListStartContainer, {
    onRemove: (id) => void removeTile(id),
    removeLabelFor: (id) => messages.tileRemoveLabel(id),
    showAllLabelFor: (hidden) => messages.tileShowAllLabel(hidden),
    loadingLabelFor: (done, total) => messages.tileLoadingProgress(done, total),
  });

  const syncTileStats = (): void => {
    store.setTileStats(core.getTileCount(), core.getTilesMemoryBytes());
  };

  const revokeTileUrl = (id: bigint): void => {
    const url = tileUrls.get(id);
    if (url !== undefined) {
      URL.revokeObjectURL(url);
      tileUrls.delete(id);
    }
  };

  /** UI スレッドへ制御を返す(大量タイル追加中も描画・操作を固めさせない) */
  const yieldToUi = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));

  const removeTile = async (id: bigint): Promise<void> => {
    try {
      await core.removeTile(id);
      tileList.removeTile(id);
      revokeTileUrl(id);
      syncTileStats();
      const remaining = core.getTileCount();
      store.dispatch({ type: 'TILES_REMOVED', remaining });
      if (remaining === 0) {
        // タイル 0 枚: MAIN_READY へ戻る(フォトモザイク表示は解除し、
        // メイン画像 + グリッド表示に戻る。基本設計書 1.4)
        progress.reset();
        if (currentGrid !== null) {
          preview.drawGrid(currentGrid, core.getBlockMeanColors());
        }
        return;
      }
      // 残りタイルがある S2 では該当ブロックの差分再マッチで自動追従する(M6)
      const data = store.getData();
      if (data.state === 'MAIN_READY' || data.state === 'DONE' || data.state === 'GENERATING') {
        await startRematch();
      }
    } catch (err) {
      console.error('removeTile failed', err);
      showError(messages.errorLoadFailed);
    }
  };

  // --- 構成画像の受け付け(複数ファイル: 検証 → デコード → サムネイル化 → コア解析) ---
  // 読み込み進捗の合算カウンタ(複数ドロップの同時進行でも単一の進捗として見せる)
  let loadingTotal = 0;
  let loadingDone = 0;
  let activeLoads = 0;

  const addTileFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    clearError();
    progress.setPhase(messages.phaseTileAnalyze);
    loadingTotal += files.length;
    activeLoads += 1;
    tileList.setLoadingProgress(loadingDone, loadingTotal);

    let added = 0;
    let rejected = 0;
    let guardExceeded = false;

    // 大量追加でも UI が固まらないよう、小バッチごとに制御を返す(handoff/04 M3)
    for (let start = 0; start < files.length; start += TILE_BATCH_SIZE) {
      const batch = files.slice(start, start + TILE_BATCH_SIZE);
      for (const file of batch) {
        if (guardExceeded) {
          rejected += 1;
          loadingDone += 1;
          continue;
        }
        try {
          const thumbs = await loadTile(file);
          const id = nextTileId;
          nextTileId += 1n;
          const info = await core.addTile(id, thumbs.feature, thumbs.compose);
          const url = URL.createObjectURL(file);
          tileUrls.set(info.id, url);
          tileList.addTile(info.id, url);
          added += 1;
        } catch (err) {
          if (err instanceof Error && err.message.includes('memory guard exceeded')) {
            // メモリガード超過(詳細設計書 5 章 memory_guard): 以降の追加を停止する
            guardExceeded = true;
          } else {
            console.error('tile load failed', err);
            rejected += 1;
          }
        }
        // 読み込み進捗と枚数・メモリ表示を 1 枚ごとに更新する
        loadingDone += 1;
        tileList.setLoadingProgress(loadingDone, loadingTotal);
        syncTileStats();
      }
      await yieldToUi();
    }

    if (added > 0) {
      // 枚数を更新する(EMPTY → TILES_READY の遷移は状態モデルに従う)
      store.dispatch({ type: 'TILES_ADDED', count: added });
      // S2(メイン画像設定済み)では差分再マッチで自動追従する(M6)。
      // メイン画像未設定(S1)では、メイン画像設定時の自動生成で反映される
      const data = store.getData();
      if (data.state === 'MAIN_READY' || data.state === 'DONE' || data.state === 'GENERATING') {
        // 要求の合流(詳細設計書 7.5): 追加完了後の最新状態だけで
        // 1 回の再マッチを開始する(追加途中での再開は行わない)
        await startRematch();
      }
    }
    syncTileStats();
    if (guardExceeded) {
      showError(messages.errorMemoryGuard);
    } else if (rejected > 0) {
      showError(messages.tilesPartiallyAdded(added, rejected));
    }
    progress.reset();
    // 同時進行のすべての読み込みが終わったら進捗表示を消す
    activeLoads -= 1;
    if (activeLoads === 0) {
      loadingTotal = 0;
      loadingDone = 0;
      tileList.hideLoading();
    }
  };

  setupFileZone(requireElement<HTMLElement>('#tile-drop-zone'), {
    multiple: true,
    onFiles: (files) => void addTileFiles(files),
  });
  setupFileZone(requireElement<HTMLElement>('#tile-drop-zone-edit'), {
    multiple: true,
    onFiles: (files) => void addTileFiles(files),
  });

  // --- S2: フォトモザイクの生成(M5: 行バッチ駆動・進捗・部分描画) ---
  // 実行世代: キャンセルで +1 し、完了コールバックが最新世代のものだけを反映する
  let generation = 0;

  // --- S2: ブロックサイズ変更(300ms デバウンス後、P2 スキップのフル再マッチで自動再生成) ---
  controls.handleBlockSizeChange(async (px) => {
    // 実行中の生成は要求の合流(詳細設計書 7.5)でバッチ境界のキャンセル後に
    // 最新状態で再開する(連続操作の無駄な再計算を中止する)
    if (store.getData().state === 'GENERATING') {
      generation += 1;
      core.cancel();
    }
    let grid: GridInfo;
    try {
      grid = await core.setBlockSize(px);
      store.setBlockCounts(grid.totalBlocks, 0);
      currentGrid = grid;
      // 変更直後はグリッド線 + 平均色で表示する(基本設計書 2.2)
      preview.drawGrid(grid, core.getBlockMeanColors());
    } catch (err) {
      // コア未設定(メイン画像なし)の変更は無視する
      console.error('setBlockSize failed', err);
      return;
    }
    // M6: 構成画像があれば自動再生成(タイル特徴量はコア内キャッシュの再利用)。
    // タイルが 0 枚の変更では再生成待ち(MAIN_READY)へ留まる
    if (store.getData().tileCount > 0) {
      store.dispatch({ type: 'GENERATION_STARTED' });
      progress.setCounts(0, grid.totalBlocks);
      await executeRun('full');
    } else {
      store.dispatch({ type: 'GENERATION_INVALIDATED' });
    }
  });

  // --- S2: メイン画像ブレンド(詳細設計書 4.6)。
  // ドラッグ中は再計算せず、確定(マウスを離した)タイミングで設定を更新し
  // フル再生成する(実行中の生成は要求の合流 7.5 でキャンセル後に再開) ---
  controls.handleMainBlendChange(async (value) => {
    const config = await core.getConfig();
    await core.setConfig({ ...config, main_blend: value });
    if (currentGrid === null || store.getData().tileCount === 0) {
      return; // 再計算の対象がない(メイン画像またはタイル未設定)
    }
    if (store.getData().state === 'GENERATING') {
      generation += 1;
      core.cancel();
    }
    store.dispatch({ type: 'GENERATION_STARTED' });
    progress.setCounts(0, currentGrid.totalBlocks);
    await executeRun('full');
  });

  /**
   * 生成・差分再マッチの共通完了処理。
   * 呼び出し時点の世代で完了を判定する(実行中の変更要求は generation を
   * 進めているため、古い実行の完了処理はスキップされる)
   */
  const executeRun = async (mode: 'full' | 'rematch'): Promise<void> => {
    const myRun = generation;
    try {
      if (mode === 'rematch') {
        await core.rematch();
      } else {
        await core.run();
      }
      if (myRun !== generation) {
        return; // キャンセル済み: 完了処理は行わない
      }
      if (store.getData().state !== 'GENERATING') {
        return; // 実行中に状態が変わった(タイル全削除など)
      }
      store.dispatch({ type: 'GENERATION_FINISHED' });
      const data = store.getData();
      const total = data.totalBlocks ?? 0;
      progress.setCounts(total, total);
      progress.setPhase(phaseLabelFor('compose'));
      const img = await core.exportImage();
      preview.drawCompleted(img);
    } catch (err) {
      if (myRun !== generation) {
        return;
      }
      console.error('generate failed', err);
      // 状態を再生成待ちへ戻した上でエラーを表示
      store.dispatch({ type: 'GENERATION_FAILED' });
      showError(messages.errorGenerate);
      progress.reset();
    } finally {
      // メトリクスオーバーレイを更新する(M7: handoff/05 §6。本番ビルドは no-op)
      try {
        metricsOverlay.update(await core.getMetrics());
      } catch (err) {
        console.warn('metrics refresh failed', err);
      }
    }
  };

  /**
   * フォトモザイクの生成を開始する(生成ボタン・自動開始)。
   * プレビューをいったんグリッド表示(平均色)へ戻し、完了した行バッチから
   * 順にフォトモザイクへ置き換わる(基本設計書 2.2)。全ブロックを再マッチする
   */
  const startGeneration = async (): Promise<void> => {
    clearError();
    if (currentGrid === null) {
      return;
    }
    preview.drawGrid(currentGrid, core.getBlockMeanColors());
    store.dispatch({ type: 'GENERATION_STARTED' });
    progress.setCounts(0, currentGrid.totalBlocks);
    await executeRun('full');
  };

  /**
   * 差分再マッチを開始する(M6: タイル追加・削除の追随)。
   * キャンセル済み実行の再開もここで行う(要求の合流: 詳細設計書 7.5)。
   * 実行中のプレビューは維持し、再マッチした行バッチのみが転写される
   */
  const startRematch = async (): Promise<void> => {
    clearError();
    if (currentGrid === null || core.getTileCount() === 0) {
      return;
    }
    if (store.getData().state === 'GENERATING') {
      // 実行中の生成をバッチ境界で停止して最新状態で再開する。
      // 直後に再開するため CANCELED 遷移には戻さない(状態は GENERATING のまま)
      generation += 1;
      core.cancel();
    }
    store.dispatch({ type: 'GENERATION_STARTED' });
    await executeRun('rematch');
  };
  controls.handleGenerate(() => void startGeneration());

  // --- 生成のキャンセル(M5): バッチ境界で停止し、再生成待ちへ戻る(詳細設計書 7.5) ---
  controls.handleCancel(() => {
    if (store.getData().state !== 'GENERATING') {
      return;
    }
    generation += 1;
    core.cancel();
    store.dispatch({ type: 'GENERATION_CANCELED' });
    progress.setPhase(messages.canceledDone);
  });

  // --- S2: 保存(コアの完成 RGBA → PNG エンコード → ダウンロード) ---
  controls.handleSave(async () => {
    try {
      progress.setPhase(messages.phaseExport);
      const image = await core.exportImage();
      const blob = await encodePng(image);
      downloadBlob(blob, buildDownloadFilename());
    } catch (err) {
      console.error('export failed', err);
      showError(messages.errorGenerate);
    } finally {
      progress.reset();
    }
  });

  // --- リセット(S2 の「戻る」がリセットを兼ねる: 全状態クリア → S1 へ) ---
  const reset = (): void => {
    // 実行中の生成があれば停止する(リセットは全状態クリア)
    generation += 1;
    core.cancel();
    store.dispatch({ type: 'RESET' });
    core.clearMainImage();
    core.clearTiles();
    tileList.clear();
    for (const url of tileUrls.values()) {
      URL.revokeObjectURL(url);
    }
    tileUrls.clear();
    nextTileId = 0n;
    currentGrid = null;
    clearError();
    progress.reset();
    metricsOverlay.clear();
    controls.setBlockSizeValue(24);
    // メイン画像ブレンドも初期化する(スライダー UI とコア設定の整合)。
    // コア設定はセッションをまたいで保持されるため、ここで明示的に戻す
    controls.setMainBlendValue(0.2);
    void (async () => {
      try {
        const config = await core.getConfig();
        await core.setConfig({ ...config, main_blend: 0.2 });
      } catch (err) {
        console.warn('config reset failed', err);
      }
    })();
  };
  controls.handleBack(reset);

  render(store.getData());
}

main().catch((err) => {
  console.error('failed to start application', err);
  // 起動失敗はコンソールだけでなく画面にも表示する(無言で操作不能になるのを防ぐ)
  const notice = document.getElementById('error-notice');
  if (notice) {
    notice.textContent = messages.errorStartup;
    notice.hidden = false;
  }
});
