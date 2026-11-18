import { useI18n } from '../../i18n';
import { StatusDot, cx } from '../../ui';
import { useDevice } from '../store/hooks';
import { displayName, modelText, type DeviceView } from '../store/deviceView';
import { ModelIcon } from './ModelIcon';

export interface DeviceBadgeProps {
  /** A view, or a UID resolved through the store. */
  device: DeviceView | string;
  /** Show the model name after the board name (default true). */
  showModel?: boolean;
  showIcon?: boolean;
  size?: 'sm' | 'md';
  onClick?: () => void;
  className?: string;
}

/** Status dot + name + model + `#num` in one line; the standard way to name a board. */
export function DeviceBadge({ device, showModel = true, showIcon = false, size = 'md', onClick, className }: DeviceBadgeProps) {
  const { lang, tl } = useI18n();
  const fromStore = useDevice(typeof device === 'string' ? device : undefined);
  const v = typeof device === 'string' ? fromStore : device;
  if (!v) return <span className={cx('cy-devbadge', 'is-missing', className)}>{typeof device === 'string' ? device : ''}</span>;
  const name = displayName(v, lang);
  const model = tl(modelText(v));
  const content = (
    <>
      <StatusDot status={v.status} size={size === 'sm' ? 7 : 8} />
      {showIcon && <ModelIcon def={v.def} size={size === 'sm' ? 13 : 15} />}
      <span className="cy-devbadge__name">{name}</span>
      {showModel && name !== model && <span className="cy-devbadge__model">{model}</span>}
      <span className={cx('cy-devbadge__num', (v.unassigned || v.conflict) && 'is-bad')}>#{v.unassigned ? '—' : v.num}</span>
    </>
  );
  const cls = cx('cy-devbadge', `cy-devbadge--${size}`, !v.online && 'is-offline', className);
  return onClick ? (
    <button type="button" className={cx(cls, 'is-button')} onClick={onClick}>
      {content}
    </button>
  ) : (
    <span className={cls}>{content}</span>
  );
}
