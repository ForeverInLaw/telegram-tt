import type { FC } from '../../lib/teact/teact';
import {
  memo, useEffect, useState,
} from '../../lib/teact/teact';

import captureKeyboardListeners from '../../util/captureKeyboardListeners';
import {
  closeActivePluginScreen, getActivePluginScreen, subscribeToPluginScreen,
} from '../../plugins/registry';

import useHistoryBack from '../../hooks/useHistoryBack';
import useLang from '../../hooks/useLang';
import useLastCallback from '../../hooks/useLastCallback';

import Button from '../ui/Button';

import './PluginScreen.scss';

/**
 * Renders the plugin-contributed full screen (opened through `tg.ui.openScreen`)
 * on top of the whole app: a header with the title and a back button, and the
 * plugin node below. Mounted once in Main, next to the other global overlays.
 */
const PluginScreen: FC = () => {
  const activeScreen = getActivePluginScreen();
  const [screenVersion, setScreenVersion] = useState(0);
  const isScreenOpen = activeScreen !== undefined;
  // `screenVersion` only exists to re-render on registry notifications.
  void screenVersion;

  useEffect(() => {
    return subscribeToPluginScreen(() => {
      setScreenVersion((version) => version + 1);
    });
  }, []);

  const lang = useLang();
  const handleBack = useLastCallback(() => {
    closeActivePluginScreen();
  });

  useEffect(() => {
    if (!isScreenOpen) return undefined;

    // `captureKeyboardListeners` returns its own cleanup (release fn)
    return captureKeyboardListeners({
      onEsc: (e: KeyboardEvent) => {
        e.preventDefault();
        handleBack();
      },
    });
  }, [isScreenOpen, handleBack]);

  useHistoryBack({
    isActive: isScreenOpen,
    onBack: handleBack,
  });

  if (activeScreen === undefined) {
    return undefined;
  }

  const { screen } = activeScreen;

  return (
    <div className="PluginScreen">
      <div className="PluginScreen-header">
        <Button
          className="PluginScreen-back"
          round
          color="translucent"
          size="smaller"
          ariaLabel={lang('Back')}
          iconName="arrow-left"
          onClick={handleBack}
        />
        <h3 className="PluginScreen-title" dir="auto">{screen.title}</h3>
      </div>
      <div className="PluginScreen-body">
        {screen.render()}
      </div>
    </div>
  );
};

export default memo(PluginScreen);
