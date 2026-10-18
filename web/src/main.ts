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
  requireElement<HTMLButtonElement>('#tile-add-edit').textContent = messages.tileAdd;
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
  const tileListStartContainer = requireElement<HTMLElement>('#tile-list-start');
  const tileListEditContainer = requireElement<HTMLElement>('#tile-list-edit');

  const preview = new Preview(requireElement<HTMLCanvasElement>('#preview-canvas'));
  const progress = new ProgressPanel(requireElement<HTMLElement>('#progress-section'));
  const controls = new Controls(screenEdit);

  // --- 進捗イベントの受信(WASM 経由。bridge が登録したコールバックへ届く) ---
  core.onProgress((event) => {
    progress.setCounts(event.assignedBlocks, event.totalBlocks);
    progress.setPhase(phaseLabelFor(event.phaseCode));
  });

  // --- 進捗デモ(M1 検証用): ダミー処理 1 秒を 16ms 間隔のバッチで進める ---
  const demoButton = requireElement<HTMLButtonElement>('#progress-demo');
  demoButton.textContent = messages.progressDemo;
  demoButton.addEventListener('click', async () => {
    if (demoButton.disabled) return;
    demoButton.disabled = true;
    progress.setPhase(phaseLabelFor('match'));
    try {
      await core.runProgressDemo(1000);
    } catch (err) {
      console.error('progress demo failed', err);
      progress.reset();
    } finally {
      demoButton.disabled = false;
    }
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

    // 保存ボタン: 本仕様では DONE で有効(基本設計書 1.4)。
    // M0 はモックのため生成フェーズを通らないので、プレビュー中(MAIN_READY 以上)で
    // 有効にしてエクスポート経路の動作確認を可能にしている(M4 で本仕様に揃える)。
    controls.setSaveEnabled(inEdit);

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
        // プレビューはコア算出のブロック平均色(P1 特徴量)で描画する
        preview.drawGrid(grid, core.getBlockMeanColors());
        progress.setPhase(messages.phaseMainAnalyze);
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
  setupFileZone(requireElement<HTMLButtonElement>('#tile-add-edit'), {
    multiple: true,
    onFiles: (files) => void addTileFiles(files),
  });

  // --- S2: ブロックサイズ変更(300ms デバウンス後にグリッド再計算) ---
  controls.handleBlockSizeChange(async (px) => {
    try {
      const grid = await core.setBlockSize(px);
      store.setBlockCounts(grid.totalBlocks, 0);
      preview.drawGrid(grid, core.getBlockMeanColors());
    } catch (err) {
      // コア未設定(メイン画像なし)の変更は無視する
      console.error('setBlockSize failed', err);
    }
  });

  // --- S2: 保存(モック exportImage → PNG エンコード → ダウンロード) ---
  controls.handleSave(async () => {
    try {
      progress.setPhase(messages.phaseExport);
      const image = await core.exportImage();
      const blob = await encodePng(image);
      downloadBlob(blob, buildDownloadFilename());
    } catch (err) {
      console.error('export failed', err);
      showError(messages.errorLoadFailed);
    } finally {
      progress.reset();
    }
  });

  // --- リセット(S2 の「戻る」がリセットを兼ねる: 全状態クリア → S1 へ) ---
  const reset = (): void => {
    store.dispatch({ type: 'RESET' });
    core.clearMainImage();
    core.clearTiles();
    tileList.clear();
    for (const url of tileUrls.values()) {
      URL.revokeObjectURL(url);
    }
    tileUrls.clear();
    nextTileId = 0n;
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
