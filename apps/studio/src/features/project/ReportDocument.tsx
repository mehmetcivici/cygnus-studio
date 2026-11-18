import { t, type Lang } from '../../i18n';
import type { ReportData } from './report';

const tr = (lang: Lang, key: string, params?: Record<string, string | number>): string => t(`project.report.${key}`, params, lang);

/**
 * The printable document. Colours are fixed (paper) and independent of the app theme, so the screen
 * preview, the print job and the downloaded HTML file look the same. All text comes from `data.lang`.
 */
export function ReportDocument({ data }: { data: ReportData }) {
  const L = data.lang;
  const when = (iso: string): string => new Date(iso).toLocaleString(L === 'tr' ? 'tr-TR' : 'en-GB');
  return (
    <article className="rp" lang={L} data-testid="pj-report-doc">
      <header className="rp-head">
        <div>
          <div className="rp-kicker">Cygnus Studio</div>
          <h1>{tr(L, 'title')}</h1>
          <div className="rp-project">{data.projectName || tr(L, 'unnamed')}</div>
        </div>
        <dl className="rp-meta">
          <div>
            <dt>{tr(L, 'generated')}</dt>
            <dd>{when(data.generatedAt)}</dd>
          </div>
          <div>
            <dt>{tr(L, 'captured')}</dt>
            <dd>{data.capturedAt ? when(data.capturedAt) : '—'}</dd>
          </div>
          <div>
            <dt>{tr(L, 'versions')}</dt>
            <dd>
              Studio {data.appVersion} · CyCAN {data.protocol}
            </dd>
          </div>
        </dl>
      </header>

      <section className="rp-summary">
        <div>
          <b>{data.cards.length}</b>
          <span>{tr(L, 'sumCards')}</span>
        </div>
        <div>
          <b>{data.changedTotal}</b>
          <span>{tr(L, 'sumChanged')}</span>
        </div>
        <div>
          <b>{data.vehicle ? data.vehicle.template : '—'}</b>
          <span>{tr(L, 'sumVehicle')}</span>
        </div>
      </section>

      <h2>{tr(L, 'cards')}</h2>
      {data.cards.length === 0 ? (
        <p className="rp-muted">{tr(L, 'noCards')}</p>
      ) : (
        <table className="rp-table">
          <thead>
            <tr>
              <th className="is-num">#</th>
              <th>{tr(L, 'colName')}</th>
              <th>{tr(L, 'colModel')}</th>
              <th className="is-num">DEVTYPE</th>
              <th>UID</th>
              <th>{tr(L, 'colFw')}</th>
              <th className="is-num">{tr(L, 'colChanged')}</th>
            </tr>
          </thead>
          <tbody>
            {data.cards.map((c) => (
              <tr key={c.uid48}>
                <td className="is-num mono">{c.num}</td>
                <td>
                  <b>{c.name || '—'}</b>
                </td>
                <td>{c.modelName}</td>
                <td className="is-num mono">{c.devType}</td>
                <td className="mono">{c.uid48}</td>
                <td className="mono">{c.fw ?? '—'}</td>
                <td className="is-num mono">{c.legacy || c.unknownModel ? '—' : c.changed.length}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h2>{tr(L, 'settings')}</h2>
      {data.cards.map((c) => (
        <section key={c.uid48} className="rp-card">
          <h3>
            #{c.num} {c.name || c.modelName} <span className="rp-muted">{c.modelName}</span>
          </h3>
          {c.legacy ? (
            <p className="rp-muted">{tr(L, 'legacy')}</p>
          ) : c.unknownModel ? (
            <p className="rp-muted">{tr(L, 'unknownModel')}</p>
          ) : c.paramCount === 0 ? (
            <p className="rp-muted">{tr(L, 'noParams')}</p>
          ) : c.changed.length === 0 ? (
            <p className="rp-muted">{tr(L, 'allDefault', { count: c.paramCount })}</p>
          ) : (
            <table className="rp-table rp-table--params">
              <thead>
                <tr>
                  <th>{tr(L, 'colGroup')}</th>
                  <th>{tr(L, 'colParam')}</th>
                  <th>{tr(L, 'colValue')}</th>
                  <th>{tr(L, 'colDefault')}</th>
                </tr>
              </thead>
              <tbody>
                {c.changed.map((p) => (
                  <tr key={p.key}>
                    <td>{p.group}</td>
                    <td>
                      {p.label} <span className="rp-muted mono">{p.key}</span>
                    </td>
                    <td className="mono">
                      <b>{p.value}</b>
                    </td>
                    <td className="mono rp-muted">{p.defaultValue}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </section>
      ))}

      {data.vehicle && (
        <>
          <h2>{tr(L, 'vehicle')}</h2>
          <p>
            <b>{data.vehicle.template}</b>
            {data.vehicle.name ? ` — ${data.vehicle.name}` : ''}
          </p>
          {data.vehicle.slots.length > 0 && (
            <table className="rp-table">
              <thead>
                <tr>
                  <th>{tr(L, 'colSlot')}</th>
                  <th>{tr(L, 'colAssigned')}</th>
                </tr>
              </thead>
              <tbody>
                {data.vehicle.slots.map((s) => (
                  <tr key={s.slot}>
                    <td>{s.slot}</td>
                    <td>{s.target}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
          {data.vehicle.unboundRequired > 0 && <p className="rp-muted">{tr(L, 'unbound', { count: data.vehicle.unboundRequired })}</p>}
        </>
      )}

      {data.notes.trim() && (
        <>
          <h2>{tr(L, 'notes')}</h2>
          <p className="rp-notes">{data.notes}</p>
        </>
      )}
      <footer className="rp-foot">{tr(L, 'footer', { version: data.appVersion })}</footer>
    </article>
  );
}
