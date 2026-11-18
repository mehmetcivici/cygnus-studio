import { useEffect, useState } from 'react';
import { Activity, Moon, OctagonX, Sun, Unplug } from 'lucide-react';
import { useI18n, type Lang } from '../i18n';
import { IconButton, Kbd, SegmentedControl, useTheme, cx } from '../ui';
import { LogoMark } from './Logo';
import { Slot } from './slots';
import { triggerEstop, useEstop } from './estop';

function EstopButton() {
  const { t, lang } = useI18n();
  const count = useEstop((s) => s.count);
  const [flash, setFlash] = useState(false);
  useEffect(() => {
    if (!count) return;
    setFlash(true);
    const h = window.setTimeout(() => setFlash(false), 600);
    return () => window.clearTimeout(h);
  }, [count]);
  return (
    <button
      type="button"
      className={cx('cy-estop', flash && 'is-flash')}
      onClick={() => triggerEstop('button')}
      title={t('app.estopHint')}
    >
      <OctagonX size={18} strokeWidth={2.4} aria-hidden />
      <span className="cy-estop__label">{t('app.estop')}</span>
      <Kbd>{lang === 'tr' ? 'Boşluk' : 'Space'}</Kbd>
    </button>
  );
}

export function TopBar() {
  const { t, lang, setLang } = useI18n();
  const theme = useTheme((s) => s.theme);
  const toggleTheme = useTheme((s) => s.toggleTheme);
  return (
    <header className="cy-topbar">
      <div className="cy-topbar__brand">
        <LogoMark />
        <div className="cy-topbar__name">
          <span className="cy-topbar__title">
            Cygnus <b>Studio</b>
          </span>
        </div>
      </div>
      <div className="cy-topbar__slots">
        <Slot
          id="topbar.connection"
          fallback={
            <span className="cy-topbar__placeholder">
              <Unplug size={15} aria-hidden />
              {t('app.noConnection')}
            </span>
          }
        />
        <Slot
          id="topbar.health"
          fallback={
            <span className="cy-topbar__placeholder is-quiet">
              <Activity size={15} aria-hidden />
              {t('app.busIdle')}
            </span>
          }
        />
      </div>
      <div className="cy-topbar__spacer" />
      <div className="cy-topbar__tools">
        <Slot id="topbar.actions" />
        <SegmentedControl<Lang>
          size="sm"
          ariaLabel={t('app.language')}
          value={lang}
          onChange={setLang}
          options={[
            { value: 'tr', label: 'TR' },
            { value: 'en', label: 'EN' },
          ]}
        />
        <IconButton
          icon={theme === 'dark' ? Sun : Moon}
          label={theme === 'dark' ? t('app.themeLight') : t('app.themeDark')}
          onClick={toggleTheme}
        />
      </div>
      <EstopButton />
    </header>
  );
}
