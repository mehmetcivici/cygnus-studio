import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useState } from 'react';
import { useI18n } from '../i18n';
import { Tooltip, cx } from '../ui';
import { readStored, writeStored } from '../lib/storage';
import { navFeatures } from '../features/registry';
import { useNav } from './nav';

const KEY = 'cy.nav.collapsed';

const NARROW = '(max-width: 1200px)';

function useNarrow(): boolean {
  const [narrow, setNarrow] = useState(() => typeof matchMedia === 'function' && matchMedia(NARROW).matches);
  useEffect(() => {
    if (typeof matchMedia !== 'function') return;
    const mq = matchMedia(NARROW);
    const on = (): void => setNarrow(mq.matches);
    mq.addEventListener('change', on);
    return () => mq.removeEventListener('change', on);
  }, []);
  return narrow;
}

export function Sidebar() {
  const { t } = useI18n();
  const screen = useNav((s) => s.screen);
  const navigate = useNav((s) => s.navigate);
  const [stored, setStored] = useState(() => readStored(KEY));
  const narrow = useNarrow();
  // No explicit choice yet: collapse by itself on narrow windows (≤ 1200 px).
  const collapsed = stored === '1' || (stored === null && narrow);
  const toggle = (): void => {
    const next = collapsed ? '0' : '1';
    writeStored(KEY, next);
    setStored(next);
  };
  return (
    <nav className={cx('cy-sidebar', collapsed && 'is-collapsed')} aria-label="Cygnus Studio">
      <ul className="cy-sidebar__list">
        {navFeatures().map((f) => {
          const Icon = f.icon;
          const label = t(f.labelKey);
          const active = f.id === screen;
          const item = (
            <button
              type="button"
              className={cx('cy-sidebar__item', active && 'is-active')}
              aria-current={active ? 'page' : undefined}
              onClick={() => navigate(f.id)}
            >
              <Icon size={19} strokeWidth={active ? 2.2 : 1.9} aria-hidden />
              <span className="cy-sidebar__label">{label}</span>
            </button>
          );
          return (
            <li key={f.id}>
              {collapsed ? (
                <Tooltip content={label} side="right" block>
                  {item}
                </Tooltip>
              ) : (
                item
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" className="cy-sidebar__collapse" onClick={toggle} aria-label={collapsed ? t('app.expand') : t('app.collapse')}>
        {collapsed ? <PanelLeftOpen size={17} aria-hidden /> : <PanelLeftClose size={17} aria-hidden />}
        <span className="cy-sidebar__label">{t('app.collapse')}</span>
      </button>
    </nav>
  );
}
