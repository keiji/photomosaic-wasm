/**
 * エントリポイント。状態遷移と UI・モックコアの結線を行う。
 *
 * M0 のデモフロー(handoff/04):
 *   S1 でメイン画像設定 → S2 でグリッド表示 → リセットで S1 へ戻る
 * 処理はすべてモックコア(グリッド計算のみ)で、WASM は M1 以降に接続する。
 */
import './style.css';
import { InvalidFileError, loadMainImage } from './io/imageLoader';
import type { LoadedImage } from './io/imageLoader';
import { buildDownloadFilename, downloadBlob, encodePng } from './io/exporter';
import { createCoreBridge, getCoreImplementation } from './core/bridge';
import { AppStore } from './state/store';
import type { AppStoreData } from './state/store';
import { messages, phaseLabelFor } from './i18n/messages';
import { setupFileZone } from './ui/dropZone';
import { Preview } from './ui/preview';
import { ProgressPanel } from './ui/progress';
import { Controls } from './ui/controls';

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

  let mainImage: LoadedImage | null = null;

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

    tileSummary.textContent = messages.tileSummary(data.tileCount);

    if (data.state === 'MAIN_READY' || data.state === 'GENERATING' || data.state === 'DONE') {
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
        mainImage = image;
        const grid = await core.setMainImage(image);
        store.dispatch({ type: 'MAIN_IMAGE_SET' });
        store.setBlockCounts(grid.totalBlocks, 0);
        preview.drawGrid(image, grid);
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

  // --- S2: ブロックサイズ変更(300ms デバウンス後にグリッド再計算) ---
  controls.handleBlockSizeChange(async (px) => {
    if (!mainImage) return;
    try {
      const grid = await core.setBlockSize(px);
      store.setBlockCounts(grid.totalBlocks, 0);
      preview.drawGrid(mainImage, grid);
    } catch (err) {
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
    mainImage = null;
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
