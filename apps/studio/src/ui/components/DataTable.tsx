import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import './DataTable.css';
import { useI18n } from '../../i18n';
import { cx, type Tone } from './types';

export type RowKey = string | number;

export interface Column<T> {
  key: string;
  header: ReactNode;
  /** px number or a CSS grid track (`'1fr'`, `'minmax(160px, 2fr)'`). Default `minmax(80px, 1fr)`. */
  width?: number | string;
  align?: 'left' | 'right' | 'center';
  /** Monospace + tabular numbers (IDs, values, hex). */
  mono?: boolean;
  /** Custom cell. Without it the cell shows `row[key]`. */
  render?: (row: T, index: number) => ReactNode;
  /** Tooltip for the header cell. */
  title?: string;
}

export interface DataTableProps<T> {
  rows: readonly T[];
  columns: readonly Column<T>[];
  rowKey: (row: T, index: number) => RowKey;
  /** Fixed row height in px (required for virtualization; default 30). */
  rowHeight?: number;
  selection?: 'none' | 'single' | 'multi';
  selected?: ReadonlySet<RowKey>;
  onSelectionChange?: (selected: Set<RowKey>) => void;
  /** Double click or Enter on a row. */
  onRowActivate?: (row: T, index: number) => void;
  /** Left stripe + tint for a row (e.g. error frames). */
  rowTone?: (row: T) => Tone | undefined;
  /** Keep scrolled to the newest row while the user is at the bottom (log views). */
  followTail?: boolean;
  /** Shown when there are no rows. */
  empty?: ReactNode;
  /** Fixed height in px; omit to fill the parent. */
  height?: number;
  ariaLabel?: string;
  className?: string;
}

const OVERSCAN = 8;

function track(w: number | string | undefined): string {
  if (w === undefined) return 'minmax(80px, 1fr)';
  return typeof w === 'number' ? `${w}px` : w;
}

function defaultCell(row: unknown, key: string): ReactNode {
  if (row && typeof row === 'object' && key in row) {
    const v = (row as Record<string, unknown>)[key];
    if (typeof v === 'string' || typeof v === 'number') return v;
    if (typeof v === 'boolean') return v ? '✓' : '';
  }
  return null;
}

/**
 * Virtualized table with sticky header and row selection. Only visible rows
 * (+ overscan) are rendered, so 10k+ rows scroll smoothly. Rows must have a
 * fixed height.
 */
export function DataTable<T>({
  rows,
  columns,
  rowKey,
  rowHeight = 30,
  selection = 'none',
  selected,
  onSelectionChange,
  onRowActivate,
  rowTone,
  followTail,
  empty,
  height,
  ariaLabel,
  className,
}: DataTableProps<T>) {
  const { t } = useI18n();
  const scrollRef = useRef<HTMLDivElement>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [viewH, setViewH] = useState(height ?? 400);
  const [active, setActive] = useState(-1);
  const anchor = useRef(-1);
  const atBottom = useRef(true);
  const raf = useRef(0);

  const template = useMemo(() => columns.map((c) => track(c.width)).join(' '), [columns]);
  const total = rows.length * rowHeight;

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setViewH(el.clientHeight));
    ro.observe(el);
    return () => {
      ro.disconnect();
      cancelAnimationFrame(raf.current);
    };
  }, []);

  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (followTail && el && atBottom.current) {
      el.scrollTop = el.scrollHeight;
      setScrollTop(el.scrollTop);
    }
  }, [rows.length, followTail]);

  const onScroll = (): void => {
    cancelAnimationFrame(raf.current);
    raf.current = requestAnimationFrame(() => {
      const el = scrollRef.current;
      if (!el) return;
      atBottom.current = el.scrollTop + el.clientHeight >= el.scrollHeight - rowHeight * 1.5;
      setScrollTop(el.scrollTop);
    });
  };

  const headerH = rowHeight + 2;
  const first = Math.max(0, Math.floor((scrollTop - headerH) / rowHeight) - OVERSCAN);
  const last = Math.min(rows.length, Math.ceil((scrollTop + viewH) / rowHeight) + OVERSCAN);

  const select = useCallback(
    (i: number, e: { shiftKey: boolean; metaKey: boolean; ctrlKey: boolean }) => {
      if (selection === 'none' || !onSelectionChange) return;
      const row = rows[i];
      if (row === undefined) return;
      const key = rowKey(row, i);
      if (selection === 'single') {
        onSelectionChange(new Set([key]));
      } else if (e.shiftKey && anchor.current >= 0) {
        const [a, b] = anchor.current < i ? [anchor.current, i] : [i, anchor.current];
        const next = new Set<RowKey>();
        for (let k = a; k <= b; k++) {
          const r = rows[k];
          if (r !== undefined) next.add(rowKey(r, k));
        }
        onSelectionChange(next);
        return;
      } else if (e.metaKey || e.ctrlKey) {
        const next = new Set(selected ?? []);
        if (next.has(key)) next.delete(key);
        else next.add(key);
        onSelectionChange(next);
      } else {
        onSelectionChange(new Set([key]));
      }
      anchor.current = i;
    },
    [selection, onSelectionChange, rows, rowKey, selected],
  );

  const scrollIntoView = (i: number): void => {
    const el = scrollRef.current;
    if (!el) return;
    const top = headerH + i * rowHeight;
    if (top - headerH < el.scrollTop) el.scrollTop = top - headerH;
    else if (top + rowHeight > el.scrollTop + el.clientHeight) el.scrollTop = top + rowHeight - el.clientHeight;
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (!rows.length) return;
    const page = Math.max(1, Math.floor(viewH / rowHeight) - 1);
    const moves: Record<string, number> = { ArrowDown: 1, ArrowUp: -1, PageDown: page, PageUp: -page };
    let next: number | null = null;
    if (e.key in moves) next = Math.max(0, Math.min(rows.length - 1, (active < 0 ? -1 : active) + (moves[e.key] ?? 0)));
    else if (e.key === 'Home') next = 0;
    else if (e.key === 'End') next = rows.length - 1;
    else if (e.key === 'Enter' && active >= 0) {
      const r = rows[active];
      if (r !== undefined) onRowActivate?.(r, active);
      return;
    }
    if (next === null) return;
    e.preventDefault();
    setActive(next);
    select(next, { shiftKey: e.shiftKey, metaKey: false, ctrlKey: false });
    scrollIntoView(next);
  };

  const body: ReactNode[] = [];
  for (let i = first; i < last; i++) {
    const row = rows[i];
    if (row === undefined) continue;
    const key = rowKey(row, i);
    const isSel = selected?.has(key) ?? false;
    const tone = rowTone?.(row);
    body.push(
      <div
        key={key}
        role="row"
        aria-rowindex={i + 2}
        aria-selected={selection !== 'none' ? isSel : undefined}
        className={cx('cy-table__row', i % 2 === 1 && 'is-odd', isSel && 'is-selected', i === active && 'is-active', tone && `cy-table__row--${tone}`)}
        style={{ height: rowHeight, gridTemplateColumns: template }}
        onMouseDown={(e: MouseEvent) => {
          if (e.shiftKey) e.preventDefault();
        }}
        onClick={(e) => {
          setActive(i);
          select(i, e);
        }}
        onDoubleClick={() => onRowActivate?.(row, i)}
      >
        {columns.map((c) => (
          <div key={c.key} role="gridcell" className={cx('cy-table__cell', c.mono && 'cy-mono', c.align && `is-${c.align}`)}>
            {c.render ? c.render(row, i) : defaultCell(row, c.key)}
          </div>
        ))}
      </div>,
    );
  }

  return (
    <div
      className={cx('cy-table', className)}
      style={height ? { height } : undefined}
      role="grid"
      aria-label={ariaLabel}
      aria-rowcount={rows.length + 1}
      aria-multiselectable={selection === 'multi' || undefined}
    >
      <div ref={scrollRef} className="cy-table__scroll" tabIndex={0} onScroll={onScroll} onKeyDown={onKeyDown}>
        <div className="cy-table__head" role="row" style={{ gridTemplateColumns: template, height: headerH }}>
          {columns.map((c) => (
            <div key={c.key} role="columnheader" title={c.title} className={cx('cy-table__th', c.align && `is-${c.align}`)}>
              {c.header}
            </div>
          ))}
        </div>
        {rows.length === 0 ? (
          <div className="cy-table__empty">{empty ?? t('ui.table.empty')}</div>
        ) : (
          <div className="cy-table__canvas" style={{ height: total }}>
            <div className="cy-table__window" style={{ transform: `translateY(${first * rowHeight}px)` }}>
              {body}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
