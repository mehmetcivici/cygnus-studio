import { useMemo, useState } from 'react';
import { Check, Clipboard, Download, TriangleAlert } from 'lucide-react';
import { useI18n } from '../../i18n';
import { Badge, Button, Checkbox, EmptyState, Panel, SegmentedControl, Tabs, toast } from '../../ui';
import { LEGACY_MODEL_NAME, downloadFile, useProject } from '../../core';
import { CODE_FILES, generate, nameCards, type CodeCard, type CodeKind, type CodeText } from './codegen';
import { codeCardOfLive, codeCardOfProject, useLiveCards } from './live';
import { tProject } from './messages';

type Source = 'project' | 'bus';

export function CodeTab() {
  const { lang, t } = useI18n();
  const project = useProject((s) => s.project);
  const { views } = useLiveCards();
  const [source, setSource] = useState<Source>(project.bus.devices.length > 0 ? 'project' : 'bus');
  const [kind, setKind] = useState<CodeKind>('c');
  const [off, setOff] = useState<ReadonlySet<number>>(new Set());
  const [copied, setCopied] = useState(false);

  const all: CodeCard[] = useMemo(
    () => (source === 'project' ? project.bus.devices.map(codeCardOfProject) : views.filter((v) => !v.unassigned && !v.conflict).map(codeCardOfLive)),
    [source, project.bus.devices, views],
  );
  const picked = all.filter((_, i) => !off.has(i));
  const names = nameCards(all);
  const text: CodeText = useMemo(
    () => ({ notice: [tProject('code.notice1'), tProject('code.notice2'), tProject('code.notice3')], source: source === 'project' ? project.name || tProject('code.unnamed') : tProject('code.liveBus') }),
    [source, project.name, lang], // eslint-disable-line react-hooks/exhaustive-deps
  );
  const code = useMemo(() => (picked.length ? generate(kind, picked, text) : ''), [kind, picked, text]);

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      toast.error(tProject('code.copyFailed'));
    }
  };
  const info = CODE_FILES[kind];

  return (
    <div className="pj-code">
      <Panel title={tProject('code.cards')} subtitle={tProject('code.count', { picked: picked.length, total: all.length })}>
        <SegmentedControl<Source>
          size="sm"
          block
          value={source}
          onChange={(v) => {
            setSource(v);
            setOff(new Set());
          }}
          ariaLabel={tProject('code.source')}
          options={[
            { value: 'project', label: tProject('code.fromProject') },
            { value: 'bus', label: tProject('code.fromBus') },
          ]}
        />
        {all.length === 0 ? (
          <EmptyState size="sm" title={tProject('code.noCards')} description={source === 'project' ? tProject('code.noCardsProject') : tProject('code.noCardsBus')} />
        ) : (
          <ul className="pj-picklist">
            {all.map((c, i) => (
              <li key={`${c.num}-${c.devType}-${i}`}>
                <Checkbox
                  checked={!off.has(i)}
                  onChange={(on) =>
                    setOff((s) => {
                      const n = new Set(s);
                      if (on) n.delete(i);
                      else n.add(i);
                      return n;
                    })
                  }
                  label={
                    <span className="pj-pick">
                      <span className="cy-mono pj-pick__id">{names[i]?.ident}</span>
                      <span className="pj-muted">
                        {c.def?.name[lang] ?? (c.modelKey === 'cyncoder_v3' ? LEGACY_MODEL_NAME[lang] : c.modelKey)} · #{c.num}
                      </span>
                    </span>
                  }
                />
              </li>
            ))}
          </ul>
        )}
      </Panel>
      <Panel
        title={tProject('code.output')}
        actions={
          <>
            <Button size="sm" icon={copied ? Check : Clipboard} disabled={!code} onClick={() => void copy()} data-testid="pj-copy">
              {copied ? tProject('code.copied') : tProject('code.copy')}
            </Button>
            <Button size="sm" variant="primary" icon={Download} disabled={!code} onClick={() => downloadFile(info.file, code, info.mime)} data-testid="pj-download-code">
              {tProject('code.download', { file: info.file })}
            </Button>
          </>
        }
      >
        <div className="pj-note pj-note--warn" role="note" data-testid="pj-code-notice">
          <TriangleAlert size={15} aria-hidden />
          <div>
            <strong>{tProject('code.noticeTitle')}</strong>
            <p>{tProject('code.noticeBody')}</p>
            <ul>
              <li>{tProject('code.notice1')}</li>
              <li>{tProject('code.notice2')}</li>
              <li>{tProject('code.notice3')}</li>
            </ul>
          </div>
        </div>
        <Tabs<CodeKind>
          variant="pill"
          value={kind}
          onChange={setKind}
          ariaLabel={tProject('code.kind')}
          items={[
            { id: 'c', label: tProject('code.kindC') },
            { id: 'arduino', label: tProject('code.kindArduino') },
            { id: 'python', label: tProject('code.kindPython') },
          ]}
        />
        {code ? <pre className="pj-pre" data-testid="pj-code" tabIndex={0}>{code}</pre> : <EmptyState size="sm" title={tProject('code.nothing')} />}
        <div className="pj-code__foot">
          <Badge size="sm" mono>
            {info.file}
          </Badge>
          <span className="pj-muted">{t(`project.code.hint.${kind}`)}</span>
        </div>
      </Panel>
    </div>
  );
}
