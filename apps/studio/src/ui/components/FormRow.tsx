import type { ReactNode } from 'react';
import { RotateCcw } from 'lucide-react';
import './FormRow.css';
import { useI18n } from '../../i18n';
import { IconButton } from './IconButton';
import { cx } from './types';

export interface FormRowProps {
  label: ReactNode;
  /** One-line explanation under the label. */
  help?: ReactNode;
  /** Small monospace identifier (e.g. parameter key `vel.kp`). */
  meta?: ReactNode;
  /** id of the control, so clicking the label focuses it. */
  htmlFor?: string;
  /** The control (NumberField, Select, Toggle, …). */
  children: ReactNode;
  /** Value differs from the device / saved state. */
  dirty?: boolean;
  error?: ReactNode;
  /** Shows a "reset to default" button. */
  onReset?: () => void;
  /** Hides the reset button when the value already equals the default. */
  isDefault?: boolean;
  /** Formatted default for the reset tooltip. */
  defaultText?: string;
  /** Flags such as Badge "Reboot required". */
  badges?: ReactNode;
  /** `horizontal` (default): label left, control right. */
  layout?: 'horizontal' | 'vertical';
  disabled?: boolean;
  className?: string;
}

/** Label + help + control + reset-to-default, aligned in a settings grid. */
export function FormRow({
  label,
  help,
  meta,
  htmlFor,
  children,
  dirty,
  error,
  onReset,
  isDefault,
  defaultText,
  badges,
  layout = 'horizontal',
  disabled,
  className,
}: FormRowProps) {
  const { t } = useI18n();
  const resetLabel = defaultText ? `${t('common.resetDefault')} (${t('common.defaultValue', { value: defaultText })})` : t('common.resetDefault');
  return (
    <div className={cx('cy-formrow', `cy-formrow--${layout}`, dirty && 'is-dirty', error != null && 'is-error', disabled && 'is-disabled', className)}>
      <div className="cy-formrow__text">
        <div className="cy-formrow__label-line">
          <label className="cy-formrow__label" htmlFor={htmlFor}>
            {label}
          </label>
          {dirty && <span className="cy-formrow__dirty" title={t('common.unsaved')} />}
          {badges}
        </div>
        {(help != null || meta != null) && (
          <div className="cy-formrow__help">
            {meta != null && <span className="cy-formrow__meta">{meta}</span>}
            {help}
          </div>
        )}
        {error != null && <div className="cy-formrow__error">{error}</div>}
      </div>
      <div className="cy-formrow__control">{children}</div>
      <div className="cy-formrow__reset">
        {onReset && !isDefault && !disabled && <IconButton size="sm" icon={RotateCcw} label={resetLabel} onClick={onReset} />}
      </div>
    </div>
  );
}
