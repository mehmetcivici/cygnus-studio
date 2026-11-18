import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Check, RefreshCw, RotateCcw, Save, Search, SlidersHorizontal } from 'lucide-react';
import type { GroupDef, ParamDef } from '@cygnus/protocol';
import { useI18n, type Lang } from '../../i18n';
import { Button, EmptyState, IconButton, Panel, ProgressBar, TextField, Toggle, toast, cx } from '../../ui';
import { describeError } from '../errors';
import { useSettings } from '../settings';
import { paramCache, useDevice } from '../store/hooks';
import { ParamDraftContext, useParamDraft, type ParamDraftApi } from './paramDraft';
import { ParamField, isParamChanged } from './ParamField';

function matches(p: ParamDef, query: string, lang: Lang): boolean {
  if (!query) return true;
  const q = query.toLocaleLowerCase(lang);
  return p.key.includes(q) || p.label[lang].toLocaleLowerCase(lang).includes(q) || p.label.tr.toLocaleLowerCase('tr').includes(q);
}

export interface ParamGroupProps {
  uid48: string;
  /** Catalog group key (or the GroupDef). */
  group: string | GroupDef;
  /** Restrict to these keys (in this order). */
  keys?: readonly string[];
  title?: ReactNode;
  actions?: ReactNode;
  /** Field mode outside a ParamForm (default immediate). */
  mode?: 'staged' | 'immediate';
  className?: string;
}

/** A panel with the parameters of one catalog group; honours the surrounding form's filters. */
export function ParamGroup({ uid48, group, keys, title, actions, mode, className }: ParamGroupProps) {
  const { tl, lang } = useI18n();
  const dev = useDevice(uid48);
  const draft = useParamDraft(uid48);
  const advancedSetting = useSettings((s) => s.advanced);
  const g = typeof group === 'string' ? dev?.def?.groups.find((x) => x.key === group) : group;
  const groupKey = typeof group === 'string' ? group : group.key;
  const filter = draft?.filter ?? { query: '', onlyChanged: false, showAdvanced: advancedSetting };
  const params = (dev?.def?.params ?? []).filter((p) => (keys ? keys.includes(p.key) : p.group === groupKey));
  const ordered = keys ? keys.map((k) => params.find((p) => p.key === k)).filter((p): p is ParamDef => !!p) : params;
  const visible = ordered.filter(
    (p) =>
      (filter.showAdvanced || !p.advanced || (draft?.drafts[p.key] ?? undefined) !== undefined) &&
      matches(p, filter.query, lang) &&
      (!filter.onlyChanged || isParamChanged(p, dev?.handle.cachedParam(p.key)) || draft?.drafts[p.key] !== undefined),
  );
  if (!dev || visible.length === 0) return null;
  return (
    <Panel title={title ?? (g ? tl(g.label) : groupKey)} actions={actions} className={cx('cy-paramgroup', className)} padding="sm">
      {visible.map((p) => (
        <ParamField key={p.key} uid48={uid48} paramKey={p.key} mode={mode} />
      ))}
    </Panel>
  );
}

export interface ParamFormProps {
  uid48: string;
  /** Only these catalog groups (default: all, in catalog order). */
  groups?: readonly string[];
  /** Search, "only changed", "advanced" and reload controls (default true). */
  toolbar?: boolean;
  /** Extra toolbar content (right side). */
  toolbarExtra?: ReactNode;
  /** Read all parameters when the form opens (default true). */
  autoLoad?: boolean;
  /** Called after Apply wrote at least one value. */
  onApplied?: (keys: string[]) => void;
  className?: string;
}

/**
 * Catalog-generated settings form for one board: grouped fields with staged edits, Apply /
 * Revert, Save to device (flash), search, "only changed" (differs from default) and advanced
 * parameters. Values load with one `readAllParams` sweep.
 */
export function ParamForm({ uid48, groups, toolbar = true, toolbarExtra, autoLoad = true, onApplied, className }: ParamFormProps) {
  const { t, lang } = useI18n();
  const dev = useDevice(uid48);
  const advancedSetting = useSettings((s) => s.advanced);
  const [query, setQuery] = useState('');
  const [onlyChanged, setOnlyChanged] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(advancedSetting);
  const [drafts, setDrafts] = useState<Record<string, number>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [applying, setApplying] = useState<ReadonlySet<string>>(new Set());
  const [loading, setLoading] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const handle = dev?.handle;
  const canParams = !!handle?.capabilities.params;
  const online = !!dev?.online;

  const reload = useCallback(async () => {
    if (!canParams) return;
    setLoading(0);
    try {
      await paramCache.loadAll(uid48, (done, total) => setLoading(total ? done / total : 1));
    } catch (e) {
      toast.error(t('core.param.readFailed'), { description: describeError(e) });
    } finally {
      setLoading(null);
    }
  }, [uid48, canParams, t]);

  useEffect(() => {
    setDrafts({});
    setErrors({});
  }, [uid48, handle]);
  useEffect(() => {
    if (autoLoad && online && handle) void reload();
  }, [autoLoad, online, handle, reload]);

  const setDraft = useCallback((key: string, value: number | undefined) => {
    setDrafts((d) => {
      const next = { ...d };
      if (value === undefined) delete next[key];
      else next[key] = value;
      return next;
    });
    setErrors((e) => {
      if (!(key in e)) return e;
      const next = { ...e };
      delete next[key];
      return next;
    });
  }, []);

  const api: ParamDraftApi = useMemo(
    () => ({ uid48, drafts, errors, applying, setDraft, filter: { query: query.trim(), onlyChanged, showAdvanced } }),
    [uid48, drafts, errors, applying, setDraft, query, onlyChanged, showAdvanced],
  );

  if (!dev) return null;
  if (!canParams) return <EmptyState size="sm" icon={SlidersHorizontal} title={t('core.param.notSupported')} description={t('core.param.notSupportedBody')} />;

  const dirtyKeys = Object.keys(drafts);
  const apply = async (): Promise<void> => {
    const keys = Object.keys(drafts);
    setApplying(new Set(keys));
    const failed: Record<string, string> = {};
    const ok: string[] = [];
    // Sequential: boards answer one parameter request at a time, and order can matter (limits).
    for (const key of keys) {
      const v = drafts[key];
      if (v === undefined) continue;
      try {
        await dev.handle.setParam(key, v);
        ok.push(key);
      } catch (e) {
        failed[key] = describeError(e);
      }
    }
    setApplying(new Set());
    setDrafts((d) => {
      const next = { ...d };
      for (const k of ok) delete next[k];
      return next;
    });
    setErrors(failed);
    if (ok.length) onApplied?.(ok);
    const nFail = Object.keys(failed).length;
    if (nFail) toast.error(t('core.param.applyPartial', { count: nFail }));
    else if (ok.length) toast.success(t('core.param.applied', { count: ok.length }), { id: `apply-${uid48}` });
  };
  const save = async (): Promise<void> => {
    setSaving(true);
    try {
      await dev.handle.save();
      toast.success(t('core.param.saved'), { id: `save-${uid48}` });
    } catch (e) {
      toast.error(t('core.param.saveFailed'), { description: describeError(e) });
    } finally {
      setSaving(false);
    }
  };

  const groupDefs = (dev.def?.groups ?? []).filter((g) => !groups || groups.includes(g.key));
  const ordered = groups ? groups.map((k) => groupDefs.find((g) => g.key === k)).filter((g): g is GroupDef => !!g) : groupDefs;
  // Same filters as ParamGroup: when none of the groups shows anything, say so instead of a blank form.
  const groupKeys = new Set(ordered.map((g) => g.key));
  const q = query.trim();
  const anyVisible = (dev.def?.params ?? []).some(
    (p) =>
      groupKeys.has(p.group) &&
      (showAdvanced || !p.advanced || drafts[p.key] !== undefined) &&
      matches(p, q, lang) &&
      (!onlyChanged || isParamChanged(p, handle?.cachedParam(p.key)) || drafts[p.key] !== undefined),
  );

  return (
    <ParamDraftContext.Provider value={api}>
      <div className={cx('cy-paramform', className)}>
        {toolbar && (
          <div className="cy-paramform__toolbar">
            <TextField value={query} onChange={setQuery} icon={Search} placeholder={t('core.param.search')} size="sm" width={240} />
            <Toggle checked={onlyChanged} onChange={setOnlyChanged} label={t('core.param.onlyChanged')} size="sm" />
            <Toggle checked={showAdvanced} onChange={setShowAdvanced} label={t('core.param.showAdvanced')} size="sm" />
            <span className="cy-paramform__spacer" />
            {toolbarExtra}
            <IconButton icon={RefreshCw} label={t('core.param.reload')} onClick={() => void reload()} disabled={loading !== null || !online} />
          </div>
        )}
        {loading !== null && <ProgressBar value={loading} />}
        <div className="cy-paramform__groups">
          {ordered.map((g) => (
            <ParamGroup key={g.key} uid48={uid48} group={g} />
          ))}
          {!anyVisible && <EmptyState icon={Search} size="sm" title={t('core.param.noMatch')} description={t('core.param.noMatchHint')} />}
        </div>
        <div className={cx('cy-paramform__footer', (dirtyKeys.length > 0 || dev.flags.unsaved) && 'is-active')}>
          <span className="cy-paramform__status">
            {dirtyKeys.length > 0
              ? t('core.param.pending', { count: dirtyKeys.length })
              : dev.flags.unsaved
                ? t('core.param.unsavedOnBoard')
                : t('core.param.inSync')}
          </span>
          <Button size="sm" variant="ghost" icon={RotateCcw} disabled={!dirtyKeys.length || applying.size > 0} onClick={() => setDrafts({})}>
            {t('common.revert')}
          </Button>
          <Button size="sm" variant="primary" icon={Check} disabled={!dirtyKeys.length || !online} loading={applying.size > 0} onClick={() => void apply()}>
            {t('common.apply')}
          </Button>
          <Button size="sm" variant="secondary" icon={Save} disabled={!online || dirtyKeys.length > 0} loading={saving} onClick={() => void save()}>
            {t('common.saveToDevice')}
          </Button>
        </div>
      </div>
    </ParamDraftContext.Provider>
  );
}
