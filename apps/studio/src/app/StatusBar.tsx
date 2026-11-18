import { useI18n } from '../i18n';
import { Slot } from './slots';

export function StatusBar() {
  const { t } = useI18n();
  return (
    <footer className="cy-statusbar">
      <div className="cy-statusbar__left">
        <Slot id="statusbar.left" />
      </div>
      <div className="cy-statusbar__right">
        <Slot id="statusbar.right" />
        <span className="cy-statusbar__item">{t('app.version', { version: __APP_VERSION__ })}</span>
      </div>
    </footer>
  );
}
