/**
 * エントリポイント。状態遷移と UI・モックコアの結線を行う。
 *
 * M0 のデモフロー(handoff/04):
 *   S1 でメイン画像設定 → S2 でグリッド表示 → リセットで S1 へ戻る
 * 処理はすべてモックコア(グリッド計算のみ)で、WASM は M1 以降に接続する。
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
  requireElement<HTMLCanvasElement>('#preview-canvas').setAttribute(
    'aria-label',
    messages.previewAriaLabel,
  );
}

async function main(): Promise<void> {
  applyMessages();

  const store = new AppStore();
  const core = await createCoreBridge();
  const coreVersion = await core.getVersion();
  // コアバージョンの表示(handoff/02: UI とコアの不整合検知)
  console.info(`photomosaic core: ${coreVersion} (impl: ${getCoreImplementation()})`);

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

  // --- タイル一覧(サムネイル + 個別削除。S1/S2 で表示位置を移動する) ---
  // タイル ID はアプリ側採番(コア API の u64 に対応し bigint を用いる)
  let nextTileId = 0n;
  const tileUrls = new Map<bigint, string>();
  const tileList = new TileList(tileListStartContainer, {
    onRemove: (id) => void removeTile(id),
    removeLabelFor: (id) => messages.tileRemoveLabel(id),
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
      // 完成済み generations はタイル構成の変更で無効になる(基本設計書 3.3)。
      // 差分再マッチ(M6)導入まで、生成のやり直しは生成ボタンで行う
      store.dispatch({ type: 'GENERATION_INVALIDATED' });
      store.dispatch({ type: 'TILES_REMOVED', remaining: core.getTileCount() });
    } catch (err) {
      console.error('removeTile failed', err);
      showError(messages.errorLoadFailed);
    }
  };

  // --- 構成画像の受け付け(複数ファイル: 検証 → デコード → サムネイル化 → コア解析) ---
  const addTileFiles = async (files: File[]): Promise<void> => {
    if (files.length === 0) return;
    clearError();
    progress.setPhase(messages.phaseTileAnalyze);

    let added = 0;
    let rejected = 0;
    let guardExceeded = false;

    // 大量追加でも UI が固まらないよう、小バッチごとに制御を返す(handoff/04 M3)
    for (let start = 0; start < files.length; start += TILE_BATCH_SIZE) {
      const batch = files.slice(start, start + TILE_BATCH_SIZE);
      for (const file of batch) {
        if (guardExceeded) {
          rejected += 1;
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
      }
      await yieldToUi();
    }

    if (added > 0) {
      // 先に生成結果を無効化(完成済みなら再生成待ちへ戻し、その後枚数を更新)
      store.dispatch({ type: 'GENERATION_INVALIDATED' });
      store.dispatch({ type: 'TILES_ADDED', count: added });
    }
    syncTileStats();
    if (guardExceeded) {
      showError(messages.errorMemoryGuard);
    } else if (rejected > 0) {
      showError(messages.tilesPartiallyAdded(added, rejected));
    }
    progress.reset();
  };

  setupFileZone(requireElement<HTMLElement>('#tile-drop-zone'), {
    multiple: true,
    onFiles: (files) => void addTileFiles(files),
  });
  setupFileZone(requireElement<HTMLElement>('#tile-drop-zone-edit'), {
    multiple: true,
    onFiles: (files) => void addTileFiles(files),
  });

  // --- S2: ブロックサイズ変更(300ms デバウンス後にグリッド再計算) ---
  controls.handleBlockSizeChange(async (px) => {
    // 生成中の変更は M6 の差分再マッチで発展させる(M5: 実行中の生成をキャンセル)。
    // 詳細設計書 7.5: 無駄な再計算をバッチ境界で中止する
    if (store.getData().state === 'GENERATING') {
      generation += 1;
      core.cancel();
      store.dispatch({ type: 'GENERATION_CANCELED' });
      progress.setPhase(messages.canceledDone);
    }
    try {
      const grid = await core.setBlockSize(px);
      store.setBlockCounts(grid.totalBlocks, 0);
      currentGrid = grid;
      preview.drawGrid(grid, core.getBlockMeanColors());
      // 完成済みの合成結果はグリッドの再計算で無効になる(コア側で composed を破棄)。
      // 再生成は生成ボタンで行う(M4。M6 で自動再生成に拡張)
      store.dispatch({ type: 'GENERATION_INVALIDATED' });
    } catch (err) {
      // コア未設定(メイン画像なし)の変更は無視する
      console.error('setBlockSize failed', err);
    }
  });

  // --- S2: フォトモザイクの生成(M5: 行バッチ駆動・進捗・部分描画) ---
  // 実行世代: キャンセルで +1 し、完了コールバックが最新世代のものだけを反映する
  let generation = 0;

  const startGeneration = async (): Promise<void> => {
    clearError();
    if (currentGrid === null) {
      return;
    }
    // 生成開始: プレビューをいったんグリッド表示(平均色)へ戻し、
    // 完了した行バッチから順にフォトモザイクへ置き換わる(基本設計書 2.2)
    preview.drawGrid(currentGrid, core.getBlockMeanColors());
    store.dispatch({ type: 'GENERATION_STARTED' });
    progress.setCounts(0, currentGrid.totalBlocks);
    const myRun = generation;
    try {
      await core.run();
      if (myRun !== generation) {
        return; // キャンセル済み: 完了処理は行わない
      }
      if (store.getData().state !== 'GENERATING') {
        return; // 実行中に状態が変わった(タイル全削除など。M6 で差分処理に発展)
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
    }
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
    controls.setBlockSizeValue(24);
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
