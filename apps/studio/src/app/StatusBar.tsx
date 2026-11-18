import { useI18n } from '../i18n';
import { Slot } from './slots';
import { useNav } from './nav';

export function StatusBar() {
  const { t } = useI18n();
  const screen = useNav((s) => s.screen);
  return (
    <footer className="cy-statusbar">
      <div className="cy-statusbar__left">
        <Slot id="statusbar.left" />
      </div>
      <div className="cy-statusbar__right">
        <Slot id="statusbar.right" />
        <span className="cy-statusbar__item cy-mono">#/{screen}</span>
        <span className="cy-statusbar__item">{t('app.version', { version: __APP_VERSION__ })}</span>
      </div>
    </footer>
  );
}
