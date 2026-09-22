import {
  memo, useEffect, useState,
} from '../../../lib/teact/teact';

import { getPluginList, togglePlugin } from '../../../plugins/host';
import { getSettingsPanels, subscribeToSettingsPanels } from '../../../plugins/registry';

import useHistoryBack from '../../../hooks/useHistoryBack';
import useLang from '../../../hooks/useLang';
import useLastCallback from '../../../hooks/useLastCallback';

import Island from '../../gili/layout/Island';
import Switch from '../../gili/primitives/Switch';
import ListItem from '../../ui/ListItem';

import styles from './SettingsPlugins.module.scss';

type OwnProps = {
  isActive?: boolean;
  onReset: () => void;
};

// Reads host state directly: UI may import from src/plugins, and plugin
// state deliberately lives outside the global store.
const SettingsPlugins = ({ isActive, onReset }: OwnProps) => {
  // The host returns stable references, so local state drives re-renders.
  const [pluginList, setPluginList] = useState(() => getPluginList());
  // Registered panels change when plugins toggle; the registry notifies, and
  // the stable-reference array keeps identity-driven re-renders cheap.
  const [, setPanelVersion] = useState(0);

  useEffect(() => subscribeToSettingsPanels(() => {
    setPanelVersion((version) => version + 1);
  }), []);

  const lang = useLang();

  useHistoryBack({
    isActive,
    onBack: onReset,
  });

  const handleToggle = useLastCallback((pluginName: string, isEnabled: boolean) => {
    togglePlugin(pluginName, isEnabled);
    setPluginList(getPluginList());
  });

  const settingsPanels = getSettingsPanels();

  return (
    <div className="settings-content custom-scroll">
      <div className="settings-content-header no-border">
        <p className="settings-item-description pt-3" dir="auto">{lang('SettingsPluginsAbout')}</p>
      </div>
      <Island>
        {pluginList.map((plugin) => (
          <ListItem
            key={plugin.name}
            narrow
            onClick={() => handleToggle(plugin.name, !plugin.isEnabled)}
          >
            <div className={styles.info}>
              <div className={styles.name}>
                {plugin.name}
                {plugin.version && <span className={styles.version}>{plugin.version}</span>}
              </div>
              {plugin.description && <div className={styles.description}>{plugin.description}</div>}
            </div>
            <Switch id={`plugin-${plugin.name}`} checked={plugin.isEnabled} />
          </ListItem>
        ))}
      </Island>
      {settingsPanels.length > 0 && (
        <Island>
          {settingsPanels.map((panel, index) => (
            <div key={`plugin-settings-panel-${index}`}>{panel.render()}</div>
          ))}
        </Island>
      )}
    </div>
  );
};

export default memo(SettingsPlugins);
