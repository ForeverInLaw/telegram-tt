import { useEffect, useState } from '@teact';

import type { TgPluginApi } from '../types';

import {
  applyBudgetGb,
  applyPerBlobCapMb,
  applyToggle,
  buildUsageView,
  clearAllArchive,
  formatBytes,
  getUsagePercent,
  MAX_PER_BLOB_CAP_MB,
  MIN_BUDGET_GB,
  MIN_PER_BLOB_CAP_MB,
} from './panelLogic';
import { getSettings } from './settings';

import useLastCallback from '../../hooks/useLastCallback';

import styles from './settingsPanel.module.scss';

type OwnProps = {
  tg: TgPluginApi;
};

/** A lang key as the util slice's translator accepts it. */
type PanelLangKey = Parameters<TgPluginApi['util']['getLocalizedString']>[0];

/** The panel's own keys: `tg.util.getLocalizedString` resolves them through the app's lang pack. */
const STRINGS = {
  captureBots: 'AntiDeleteSettingsCaptureBots',
  ghostTransparency: 'AntiDeleteSettingsGhostTransparency',
  prefetchVideos: 'AntiDeleteSettingsPrefetchVideos',
  mediaBudget: 'AntiDeleteSettingsMediaBudget',
  perBlobCap: 'AntiDeleteSettingsPerBlobCap',
  usage: 'AntiDeleteSettingsUsage',
  quota: 'AntiDeleteSettingsQuota',
  clearAll: 'AntiDeleteSettingsClearAll',
  clearAllConfirm: 'AntiDeleteSettingsClearAllConfirm',
  clearAllDescription: 'AntiDeleteSettingsClearAllDescription',
} as const;

/**
 * The anti-delete plugin's settings panel, rendered by the app inside
 * Settings → Plugins through the `tg.ui.registerSettingsPanel` seam (see
 * `registerPanel.ts`). Every control reads the plugin's persisted settings
 * module and writes it back through `updateSettings`, so changes apply
 * without a reload: the capture pipeline (bots toggle), the ghost renderer
 * (transparency toggle) and the media capture (video prefetch toggle) all
 * read the settings cache live. The budget and the per-blob cap also push
 * their bytes to the storage engine immediately. Plugin folders import no
 * app components, so the controls are native inputs styled by the module's
 * SCSS; strings resolve through `tg.util.getLocalizedString`.
 */
function AntiDeleteSettingsPanel({ tg }: OwnProps) {
  const translate = (key: PanelLangKey) => tg.util.getLocalizedString(key);

  const [usageView, setUsageView] = useState(() => buildUsageView({
    usedBytes: 0, budgetBytes: getSettings().budgetBytes, quotaBytes: 0,
  }));
  const [isClearing, setIsClearing] = useState(false);
  const [isClearConfirmVisible, setIsClearConfirmVisible] = useState(false);

  const refreshUsageView = useLastCallback(async () => {
    const usage = await tg.storage.getUsage();
    setUsageView(buildUsageView(usage));
  });

  // Poll on mount: the usage snapshot arrives async, and its quota clamps
  // the budget slider's maximum.
  useEffect(() => {
    void refreshUsageView();
  }, [refreshUsageView]);

  const settings = getSettings();

  function handleToggleChange(key: 'shouldCaptureBots' | 'shouldGhostBeTransparent' | 'shouldPrefetchVideos') {
    return (event: { currentTarget: { checked: boolean } }) => {
      applyToggle(key, event.currentTarget.checked);
      void refreshUsageView();
    };
  }

  function handleBudgetChange(event: { currentTarget: { value: string } }) {
    const budgetBytes = applyBudgetGb(Number(event.currentTarget.value));
    // The plugin's own settings keep the chosen position; the engine clamps
    // the effective budget to 50% of the quota at runtime.
    void tg.storage.setBudgetBytes(budgetBytes).then(refreshUsageView);
  }

  function handlePerBlobCapChange(event: { currentTarget: { value: string } }) {
    const perBlobCapBytes = applyPerBlobCapMb(Number(event.currentTarget.value));
    void tg.storage.setPerBlobCapBytes(perBlobCapBytes).then(refreshUsageView);
  }

  async function handleClearConfirm() {
    setIsClearConfirmVisible(false);
    setIsClearing(true);
    try {
      await clearAllArchive(tg);
    } finally {
      setIsClearing(false);
    }
    await refreshUsageView();
  }

  const { usage, budgetGb, budgetSliderMaxGb, perBlobCapMb } = usageView;
  const usagePercent = getUsagePercent(usage);
  const usageFillClassName = usagePercent >= 100
    ? `${styles.usageFill} ${styles.usageFillFull}`
    : styles.usageFill;

  return (
    <div className={styles.panel}>
      <label className={styles.settingsRow}>
        <span>{translate(STRINGS.captureBots)}</span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={settings.shouldCaptureBots}
          onChange={handleToggleChange('shouldCaptureBots')}
        />
      </label>

      <label className={styles.settingsRow}>
        <span>{translate(STRINGS.ghostTransparency)}</span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={settings.shouldGhostBeTransparent}
          onChange={handleToggleChange('shouldGhostBeTransparent')}
        />
      </label>

      <label className={styles.settingsRow}>
        <span>{translate(STRINGS.prefetchVideos)}</span>
        <input
          type="checkbox"
          className={styles.checkbox}
          checked={settings.shouldPrefetchVideos}
          onChange={handleToggleChange('shouldPrefetchVideos')}
        />
      </label>

      <div className={styles.sliderBlock}>
        <div className={styles.sliderLabel}>
          {translate(STRINGS.mediaBudget)}
          {' '}
          {`${budgetGb} GB`}
        </div>
        <input
          type="range"
          className={styles.rangeInput}
          min={MIN_BUDGET_GB}
          max={budgetSliderMaxGb}
          step={1}
          value={budgetGb}
          onChange={handleBudgetChange}
        />
      </div>

      <div className={styles.sliderBlock}>
        <div className={styles.sliderLabel}>
          {translate(STRINGS.perBlobCap)}
          {' '}
          {`${perBlobCapMb} MB`}
        </div>
        <input
          type="range"
          className={styles.rangeInput}
          min={MIN_PER_BLOB_CAP_MB}
          max={MAX_PER_BLOB_CAP_MB}
          step={8}
          value={perBlobCapMb}
          onChange={handlePerBlobCapChange}
        />
      </div>

      <div className={styles.usageBlock}>
        <div className={styles.sliderLabel}>{translate(STRINGS.usage)}</div>
        <div
          className={styles.usageBar}
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={usagePercent}
        >
          <div className={usageFillClassName} style={`width: ${usagePercent}%`} />
        </div>
        <div className={styles.usageText}>
          <span>{`${formatBytes(usage.usedBytes)} / ${formatBytes(usage.budgetBytes)}`}</span>
          <span>{`${translate(STRINGS.quota)}: ${formatBytes(usage.quotaBytes)}`}</span>
        </div>
      </div>

      <div className={styles.clearBlock}>
        <div className={styles.clearDescription}>{translate(STRINGS.clearAllDescription)}</div>
        {isClearConfirmVisible ? (
          <div className={styles.confirmRow}>
            <span className={styles.confirmText}>{translate(STRINGS.clearAllConfirm)}</span>
            <button
              type="button"
              className={styles.clearButton}
              disabled={isClearing}
              onClick={handleClearConfirm}
            >
              {translate('Clear')}
            </button>
            <button
              type="button"
              className={styles.confirmButton}
              onClick={() => setIsClearConfirmVisible(false)}
            >
              {translate('Cancel')}
            </button>
          </div>
        ) : (
          <button
            type="button"
            className={styles.clearButton}
            onClick={() => setIsClearConfirmVisible(true)}
          >
            {translate(STRINGS.clearAll)}
          </button>
        )}
      </div>
    </div>
  );
}

export default AntiDeleteSettingsPanel;
