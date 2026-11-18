import { Moon, Sun } from 'lucide-react';
import { PROTO_MAJOR, PROTO_MINOR } from '@cygnus/protocol';
import { useI18n, type Lang } from '../../i18n';
import { Badge, FormRow, Panel, SegmentedControl, Toggle, useTheme, type ThemeName } from '../../ui';
import { setLang, setTheme, updateSettings, useSettings, type AngleUnit, type TempUnit } from '../../core';
import { catalogRows } from './report';
import { tProject } from './messages';

export function SettingsTab() {
  const { lang } = useI18n();
  const theme = useTheme((s) => s.theme);
  const s = useSettings();
  const rows = catalogRows(lang);
  return (
    <div className="pj-grid">
      <div className="pj-stack">
        <Panel title={tProject('set.appearance')}>
          <div className="pj-settings">
            <FormRow label={tProject('set.language')} help={tProject('set.languageHelp')}>
              <SegmentedControl<Lang>
                size="sm"
                value={lang}
                onChange={setLang}
                ariaLabel={tProject('set.language')}
                options={[
                  { value: 'tr', label: 'Türkçe' },
                  { value: 'en', label: 'English' },
                ]}
              />
            </FormRow>
            <FormRow label={tProject('set.theme')} help={tProject('set.themeHelp')}>
              <SegmentedControl<ThemeName>
                size="sm"
                value={theme}
                onChange={setTheme}
                ariaLabel={tProject('set.theme')}
                options={[
                  { value: 'dark', label: tProject('set.dark'), icon: Moon },
                  { value: 'light', label: tProject('set.light'), icon: Sun },
                ]}
              />
            </FormRow>
            <FormRow label={tProject('set.advanced')} help={tProject('set.advancedHelp')}>
              <Toggle checked={s.advanced} onChange={(v) => updateSettings({ advanced: v })} ariaLabel={tProject('set.advanced')} />
            </FormRow>
          </div>
        </Panel>
        <Panel title={tProject('set.numbers')}>
          <div className="pj-settings">
            <FormRow label={tProject('set.hexIds')} help={tProject('set.hexIdsHelp')}>
              <SegmentedControl<'hex' | 'dec'>
                size="sm"
                value={s.hexIds ? 'hex' : 'dec'}
                onChange={(v) => updateSettings({ hexIds: v === 'hex' })}
                ariaLabel={tProject('set.hexIds')}
                options={[
                  { value: 'hex', label: '0x1A' },
                  { value: 'dec', label: '26' },
                ]}
              />
            </FormRow>
            <FormRow label={tProject('set.angle')} help={tProject('set.angleHelp')}>
              <SegmentedControl<AngleUnit>
                size="sm"
                value={s.angleUnit}
                onChange={(v) => updateSettings({ angleUnit: v })}
                ariaLabel={tProject('set.angle')}
                options={[
                  { value: 'rot', label: 'rot' },
                  { value: 'deg', label: '°' },
                ]}
              />
            </FormRow>
            <FormRow label={tProject('set.temp')}>
              <SegmentedControl<TempUnit>
                size="sm"
                value={s.tempUnit}
                onChange={(v) => updateSettings({ tempUnit: v })}
                ariaLabel={tProject('set.temp')}
                options={[
                  { value: 'C', label: '°C' },
                  { value: 'F', label: '°F' },
                ]}
              />
            </FormRow>
          </div>
        </Panel>
      </div>
      <Panel title={tProject('set.versions')}>
        <dl className="pj-meta pj-meta--wide">
          <div>
            <dt>{tProject('set.appVersion')}</dt>
            <dd className="cy-mono" data-testid="pj-app-version">
              {__APP_VERSION__}
            </dd>
          </div>
          <div>
            <dt>{tProject('set.protocolVersion')}</dt>
            <dd className="cy-mono">
              CyCAN {PROTO_MAJOR}.{PROTO_MINOR}
            </dd>
          </div>
        </dl>
        <h3 className="pj-subhead">{tProject('set.catalogs')}</h3>
        <table className="pj-table" data-testid="pj-catalog-table">
          <thead>
            <tr>
              <th>{tProject('set.col.model')}</th>
              <th>{tProject('set.col.key')}</th>
              <th className="is-num">DEVTYPE</th>
              <th className="is-num">{tProject('set.col.rev')}</th>
              <th className="is-num">{tProject('set.col.params')}</th>
              <th className="is-num">{tProject('set.col.signals')}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.model}>
                <td>
                  {r.name} <span className="pj-muted">#{r.model}</span>
                </td>
                <td className="cy-mono">{r.key}</td>
                <td className="is-num cy-mono">{r.devType}</td>
                <td className="is-num">
                  <Badge mono size="sm" tone="accent">
                    {r.rev}
                  </Badge>
                </td>
                <td className="is-num cy-mono">{r.params}</td>
                <td className="is-num cy-mono">{r.signals}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </Panel>
    </div>
  );
}
