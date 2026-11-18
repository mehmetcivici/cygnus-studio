import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { ChevronDown, ChevronUp } from 'lucide-react';
import './field.css';
import './NumberField.css';
import { decimalSeparator, fmtNumber, useI18n } from '../../i18n';
import { decimalsOf, formatEditable, parseNumber, stepNumber, validateNumber, type NumberError } from './numberField.logic';
import { cx, type ControlSize } from './types';

export interface NumberFieldProps {
  /** Committed value (e.g. the form or device value). null = unknown. */
  value: number | null;
  /** Called with a valid value on Enter, blur, or (with `commitOnStep`) on each step. */
  onCommit: (value: number) => void;
  unit?: string;
  min?: number;
  max?: number;
  /** Arrow/wheel increment (default derives from `digits`, else 1). */
  step?: number;
  /** Display decimals (default derives from `step`). */
  digits?: number;
  integer?: boolean;
  /** Commit immediately on arrow/wheel steps (live tuning). Default false. */
  commitOnStep?: boolean;
  /** Externally dirty: value differs from what is on the device. */
  dirty?: boolean;
  /** External error text (overrides validation display). */
  error?: string;
  /** Render validation error text under the field (default true). */
  showErrorText?: boolean;
  disabled?: boolean;
  readOnly?: boolean;
  size?: ControlSize;
  /** CSS width (default 140px). */
  width?: number | string;
  placeholder?: string;
  id?: string;
  ariaLabel?: string;
  className?: string;
}

/**
 * Engineering number input. Typing edits a local draft; Enter (or blur)
 * commits a valid value, Esc reverts. ↑/↓ and the wheel (while focused) step
 * by `step` (Shift ×10, Alt ×0.1). Accepts both `,` and `.` as decimal mark.
 */
export function NumberField({
  value,
  onCommit,
  unit,
  min,
  max,
  step,
  digits,
  integer,
  commitOnStep,
  dirty,
  error: externalError,
  showErrorText = true,
  disabled,
  readOnly,
  size = 'md',
  width = 140,
  placeholder,
  id,
  ariaLabel,
  className,
}: NumberFieldProps) {
  const { t, lang } = useI18n();
  const autoId = useId();
  const inputId = id ?? autoId;
  const inputRef = useRef<HTMLInputElement>(null);
  const effStep = step ?? (digits !== undefined ? 10 ** -digits : 1);
  const effDigits = digits ?? (integer ? 0 : decimalsOf(effStep));
  const constraints = { min, max, step: effStep, integer };
  const mark = decimalSeparator(lang);

  const [draft, setDraft] = useState<string | null>(null);
  const parsed = draft === null ? value : parseNumber(draft);
  const validation: NumberError | null = draft === null ? null : validateNumber(parsed, constraints);
  const pending = draft !== null && validation === null && parsed !== value;

  const errorText =
    externalError ??
    (validation
      ? validation.kind === 'min'
        ? t('ui.number.min', { min: fmtNumber(validation.limit, effDigits, { lang, grouping: false }) })
        : validation.kind === 'max'
          ? t('ui.number.max', { max: fmtNumber(validation.limit, effDigits, { lang, grouping: false }) })
          : validation.kind === 'integer'
            ? t('ui.number.integer')
            : t('ui.number.invalid')
      : undefined);

  const display = draft ?? (value === null ? '' : fmtNumber(value, effDigits, { lang, grouping: false }));

  const commit = (): boolean => {
    if (draft === null) return true;
    if (validation || parsed === null) return false;
    if (parsed !== value) onCommit(parsed);
    setDraft(formatEditable(parsed, effDigits, mark));
    return true;
  };

  const doStep = (dir: 1 | -1, mult: number): void => {
    if (disabled || readOnly) return;
    const base = parsed ?? value ?? min ?? 0;
    const next = stepNumber(base, dir, constraints, mult);
    setDraft(formatEditable(next, mult < 1 ? Math.max(effDigits, effDigits + 1) : effDigits, mark));
    if (commitOnStep && next !== value) onCommit(next);
  };

  // Wheel stepping needs a non-passive listener to stop page scroll; only while focused.
  const stepRef = useRef(doStep);
  stepRef.current = doStep;
  useEffect(() => {
    const el = inputRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent): void => {
      if (document.activeElement !== el) return;
      e.preventDefault();
      stepRef.current(e.deltaY < 0 ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, []);

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') {
      e.preventDefault();
      commit();
    } else if (e.key === 'Escape') {
      if (draft !== null) {
        e.preventDefault();
        e.stopPropagation();
        setDraft(formatEditable(value, effDigits, mark));
      }
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowDown') {
      e.preventDefault();
      doStep(e.key === 'ArrowUp' ? 1 : -1, e.shiftKey ? 10 : e.altKey ? 0.1 : 1);
    }
  };

  const errId = `${inputId}-err`;
  return (
    <span className={cx('cy-numfield', className)} style={{ width }}>
      <span
        className={cx(
          'cy-input',
          `cy-input--${size}`,
          'cy-input--block',
          errorText && 'is-error',
          disabled && 'is-disabled',
          readOnly && 'is-readonly',
          dirty && 'is-dirty',
          pending && 'is-pending',
        )}
        title={readOnly || disabled ? undefined : t('ui.number.hint')}
      >
        {(dirty || pending) && <span className="cy-numfield__dirty" aria-hidden />}
        <input
          ref={inputRef}
          id={inputId}
          className="cy-input__control cy-numfield__input"
          inputMode="decimal"
          data-numeric=""
          autoComplete="off"
          spellCheck={false}
          value={display}
          placeholder={placeholder}
          disabled={disabled}
          readOnly={readOnly}
          aria-label={ariaLabel}
          aria-invalid={errorText ? true : undefined}
          aria-describedby={errorText ? errId : undefined}
          onFocus={(e) => {
            if (readOnly) return;
            setDraft(formatEditable(value, effDigits, mark));
            const el = e.currentTarget;
            requestAnimationFrame(() => el.select());
          }}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => {
            // Invalid drafts are dropped on blur: the committed value stays authoritative.
            commit();
            setDraft(null);
          }}
          onKeyDown={onKeyDown}
        />
        {unit && <span className="cy-input__affix cy-numfield__unit">{unit}</span>}
        {!readOnly && !disabled && (
          <span className="cy-numfield__steppers" aria-hidden>
            <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={(e) => doStep(1, e.shiftKey ? 10 : 1)}>
              <ChevronUp size={11} strokeWidth={2.5} />
            </button>
            <button type="button" tabIndex={-1} onMouseDown={(e) => e.preventDefault()} onClick={(e) => doStep(-1, e.shiftKey ? 10 : 1)}>
              <ChevronDown size={11} strokeWidth={2.5} />
            </button>
          </span>
        )}
      </span>
      {showErrorText && errorText && (
        <span id={errId} className="cy-field-error" role="alert">
          {errorText}
        </span>
      )}
    </span>
  );
}
