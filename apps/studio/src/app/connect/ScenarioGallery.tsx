import { CarFront, FlaskConical, Sparkles, type LucideIcon } from 'lucide-react';
import { scenarios, type ScenarioInfo } from '@cygnus/simulator';
import { useI18n } from '../../i18n';
import { cx } from '../../ui';
import { connection, useConnection } from '../../core';
import { tShell } from '../messages';

const ORDER: ScenarioInfo['category'][] = ['demo', 'bench', 'vehicle'];
const ICON: Record<ScenarioInfo['category'], LucideIcon> = { demo: Sparkles, bench: FlaskConical, vehicle: CarFront };

export function scenarioInfo(id: string | null | undefined): ScenarioInfo | undefined {
  return id ? scenarios.find((s) => s.id === id) : undefined;
}

export interface ScenarioGalleryProps {
  /** `compact`: dense rows for the top-bar menu; `cards`: large tiles for the welcome screen. */
  variant?: 'compact' | 'cards';
  onStarted?: () => void;
}

/** Simulator scenarios grouped by category; click starts one. */
export function ScenarioGallery({ variant = 'compact', onStarted }: ScenarioGalleryProps) {
  const { tl } = useI18n();
  const source = useConnection((s) => s.source);
  const phase = useConnection((s) => s.phase);
  const activeId = source?.kind === 'sim' && (phase === 'connected' || phase === 'connecting') ? source.scenarioId : null;
  return (
    <div className={cx('cy-scenarios', `cy-scenarios--${variant}`)}>
      {ORDER.map((cat) => {
        const list = scenarios.filter((s) => s.category === cat);
        if (!list.length) return null;
        const Icon = ICON[cat];
        return (
          <section key={cat} className="cy-scenarios__cat">
            <header className="cy-scenarios__head">
              <Icon size={14} aria-hidden />
              <span className="cy-scenarios__title">{tShell(`conn.category.${cat}`)}</span>
              {variant === 'cards' && <span className="cy-scenarios__hint">{tShell(`conn.categoryHint.${cat}`)}</span>}
            </header>
            <div className="cy-scenarios__grid">
              {list.map((s) => {
                const active = s.id === activeId;
                return (
                  <button
                    type="button"
                    key={s.id}
                    className={cx('cy-scenario', active && 'is-active')}
                    onClick={() => {
                      onStarted?.();
                      void connection.connect({ kind: 'sim', scenarioId: s.id });
                    }}
                    title={tl(s.description)}
                  >
                    <span className="cy-scenario__name">
                      {tl(s.name)}
                      {active && <span className="cy-scenario__active">{tShell('conn.active')}</span>}
                    </span>
                    <span className="cy-scenario__desc">{tl(s.description)}</span>
                  </button>
                );
              })}
            </div>
          </section>
        );
      })}
    </div>
  );
}
