/**
 * Form controls: Form, Input (+TextArea, Password), InputAdornment, SearchBox,
 * Switch, Checkbox, Segment, DatePicker, Upload.
 *
 * Controlled controls call `onChange(value, { event })` - value first - which is the
 * contract every page in the panel is written against.
 */
import {
  forwardRef,
  useRef,
  useState,
  type CSSProperties,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
} from 'react';
import moment, { type Moment } from 'moment';
import { Check, Eye, EyeOff, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, controlWidth, sizeClass, type ChangeContext, type ControlSize } from './internal';
import { Tooltip } from './Tooltip';

// ───────────────────────── Form ─────────────────────────

export interface FormProps {
  layout?: 'default' | 'vertical' | 'inline' | 'fixed';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onSubmit?: React.FormEventHandler<HTMLFormElement>;
}

function FormRoot({ layout = 'default', className, style, children, onSubmit }: FormProps) {
  return (
    <form
      className={cn('wf-form', `wf-form--${layout}`, className)}
      style={style}
      onSubmit={(e) => {
        e.preventDefault();
        onSubmit?.(e);
      }}
    >
      {children}
    </form>
  );
}

export interface FormItemProps {
  label?: ReactNode;
  required?: boolean;
  /** Help text under the control. */
  extra?: ReactNode;
  /** Validation state. */
  status?: 'error' | 'warning' | 'success' | 'validating';
  /** Validation message (shown instead of `extra` when present). */
  message?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

function FormItem({ label, required, extra, status, message, className, style, children }: FormItemProps) {
  return (
    <div className={cn('wf-form__item', status && `is-${status}`, className)} style={style}>
      {label !== undefined && (
        <div className="wf-form__label">
          {required && <span className="wf-form__required" aria-hidden>*</span>}
          {label}
        </div>
      )}
      <div className="wf-form__control">
        {children}
        {(message || extra) && <div className={cn('wf-form__help', message && 'is-message')}>{message ?? extra}</div>}
      </div>
    </div>
  );
}

function FormText({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('wf-form__text', className)}>{children}</div>;
}

export const Form = Object.assign(FormRoot, { Item: FormItem, Text: FormText });

// ───────────────────────── Input ─────────────────────────

type NativeInputProps = Omit<InputHTMLAttributes<HTMLInputElement>, 'onChange' | 'size' | 'value'>;

export interface InputProps extends NativeInputProps {
  value?: string;
  onChange?: (value: string, context: ChangeContext<React.ChangeEvent<HTMLInputElement>>) => void;
  /** Called when Enter is pressed (ignored while an IME composition is active). */
  onPressEnter?: (event: React.KeyboardEvent<HTMLInputElement>) => void;
  size?: ControlSize;
  /** Read-only display (alias of the native attribute). */
  readonly?: boolean;
  /** Accepted for API parity; validation is handled by the surrounding form. */
  rules?: boolean;
}

const InputBase = forwardRef<HTMLInputElement, InputProps>(function Input(
  { value, onChange, onPressEnter, onKeyDown, size, readonly, readOnly, rules: _rules, className, style, ...rest },
  ref,
) {
  return (
    <input
      ref={ref}
      className={cn('wf-input', sizeClass('wf-input', size), className)}
      style={{ ...controlWidth(size), ...style }}
      value={value ?? ''}
      readOnly={readonly ?? readOnly}
      onChange={(e) => onChange?.(e.target.value, { event: e })}
      onKeyDown={(e) => {
        onKeyDown?.(e);
        if (onPressEnter && e.key === 'Enter' && !e.nativeEvent.isComposing) onPressEnter(e);
      }}
      {...rest}
    />
  );
});

type NativeTextAreaProps = Omit<TextareaHTMLAttributes<HTMLTextAreaElement>, 'onChange' | 'value'>;

export interface TextAreaProps extends NativeTextAreaProps {
  value?: string;
  onChange?: (value: string, context: ChangeContext<React.ChangeEvent<HTMLTextAreaElement>>) => void;
  size?: ControlSize;
  readonly?: boolean;
  /** Show a character counter (requires maxLength). */
  showCount?: boolean;
}

const TextArea = forwardRef<HTMLTextAreaElement, TextAreaProps>(function TextArea(
  { value, onChange, size, readonly, readOnly, className, style, rows = 4, showCount, maxLength, ...rest },
  ref,
) {
  const area = (
    <textarea
      ref={ref}
      rows={rows}
      maxLength={maxLength}
      className={cn('wf-input wf-textarea', sizeClass('wf-input', size), className)}
      style={{ ...controlWidth(size), ...style }}
      value={value ?? ''}
      readOnly={readonly ?? readOnly}
      onChange={(e) => onChange?.(e.target.value, { event: e })}
      {...rest}
    />
  );
  if (!showCount || !maxLength) return area;
  return (
    <div className="wf-textarea-wrap">
      {area}
      <span className="wf-textarea__count">
        {(value ?? '').length}/{maxLength}
      </span>
    </div>
  );
});

const Password = forwardRef<HTMLInputElement, InputProps>(function Password({ size, className, style, ...rest }, ref) {
  const { t } = useTranslation();
  const [visible, setVisible] = useState(false);
  return (
    <span className={cn('wf-input-affix', sizeClass('wf-input', size), className)} style={{ ...controlWidth(size), ...style }}>
      <InputBase ref={ref} type={visible ? 'text' : 'password'} size="full" autoComplete="off" {...rest} />
      <button
        type="button"
        className="wf-input-affix__btn"
        aria-label={visible ? t('ui.password.hide') : t('ui.password.show')}
        onClick={() => setVisible((v) => !v)}
      >
        {visible ? <EyeOff size={14} /> : <Eye size={14} />}
      </button>
    </span>
  );
});

export const Input = Object.assign(InputBase, { TextArea, Password });

// ───────────────────────── InputAdornment ─────────────────────────

export function InputAdornment({
  before,
  after,
  className,
  style,
  children,
}: {
  before?: ReactNode;
  after?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  appearance?: string;
}) {
  return (
    <div className={cn('wf-input-adornment', className)} style={style}>
      {before && <span className="wf-input-adornment__addon wf-input-adornment__addon--before">{before}</span>}
      <div className="wf-input-adornment__field">{children}</div>
      {after && <span className="wf-input-adornment__addon wf-input-adornment__addon--after">{after}</span>}
    </div>
  );
}

// ───────────────────────── SearchBox ─────────────────────────

export interface SearchBoxProps {
  value?: string;
  onChange?: (value: string, context: ChangeContext) => void;
  onSearch?: (value: string) => void;
  onClear?: () => void;
  placeholder?: string;
  size?: ControlSize;
  disabled?: boolean;
  className?: string;
  style?: CSSProperties;
  autoFocus?: boolean;
}

export function SearchBox({
  value,
  onChange,
  onSearch,
  onClear,
  placeholder,
  size,
  disabled,
  className,
  style,
  autoFocus,
}: SearchBoxProps) {
  const { t } = useTranslation();
  const v = value ?? '';
  return (
    <div className={cn('wf-search', sizeClass('wf-search', size), className)} style={{ ...controlWidth(size ?? 'l'), ...style }}>
      <Search className="wf-search__icon" size={14} aria-hidden />
      <input
        type="search"
        className="wf-search__input"
        value={v}
        placeholder={placeholder ?? t('ui.search')}
        disabled={disabled}
        autoFocus={autoFocus}
        onChange={(e) => onChange?.(e.target.value, { event: e })}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) onSearch?.(v);
        }}
      />
      {v && !disabled && (
        <button
          type="button"
          className="wf-search__clear"
          aria-label={t('ui.clear')}
          onClick={() => {
            onChange?.('', {});
            onClear?.();
            onSearch?.('');
          }}
        >
          <X size={12} />
        </button>
      )}
    </div>
  );
}

// ───────────────────────── Switch ─────────────────────────

export interface SwitchProps {
  value?: boolean;
  onChange?: (value: boolean, context: ChangeContext) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
  title?: string;
}

export function Switch({ value, onChange, disabled, className, children, title }: SwitchProps) {
  return (
    <label className={cn('wf-switch-label', disabled && 'is-disabled', className)} title={title}>
      <button
        type="button"
        role="switch"
        aria-checked={!!value}
        disabled={disabled}
        className={cn('wf-switch', value && 'is-checked')}
        onClick={(e) => onChange?.(!value, { event: e })}
      >
        <span className="wf-switch__thumb" />
      </button>
      {children && <span className="wf-switch__text">{children}</span>}
    </label>
  );
}

// ───────────────────────── Checkbox ─────────────────────────

export interface CheckboxProps {
  value?: boolean;
  indeterminate?: boolean;
  onChange?: (value: boolean, context: ChangeContext) => void;
  disabled?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Checkbox({ value, indeterminate, onChange, disabled, className, children }: CheckboxProps) {
  return (
    <label className={cn('wf-checkbox', value && 'is-checked', disabled && 'is-disabled', className)}>
      <input
        type="checkbox"
        className="wf-checkbox__input"
        checked={!!value}
        disabled={disabled}
        ref={(el) => {
          if (el) el.indeterminate = !!indeterminate;
        }}
        onChange={(e) => onChange?.(e.target.checked, { event: e })}
      />
      <span className="wf-checkbox__box" aria-hidden>
        {indeterminate ? <span className="wf-checkbox__dash" /> : value ? <Check size={11} strokeWidth={3} /> : null}
      </span>
      {children && <span className="wf-checkbox__text">{children}</span>}
    </label>
  );
}

// ───────────────────────── Segment ─────────────────────────

export interface SegmentOption {
  value: string;
  text?: ReactNode;
  disabled?: boolean;
  tooltip?: ReactNode;
}

export interface SegmentProps {
  value?: string;
  onChange?: (value: string, context: ChangeContext) => void;
  options: SegmentOption[];
  className?: string;
  style?: CSSProperties;
  disabled?: boolean;
}

export function Segment({ value, onChange, options, className, style, disabled }: SegmentProps) {
  return (
    <div role="radiogroup" className={cn('wf-segment', className)} style={style}>
      {options.map((o) => {
        const active = o.value === value;
        const btn = (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled || o.disabled}
            className={cn('wf-segment__item', active && 'is-selected')}
            onClick={(e) => {
              if (!active) onChange?.(o.value, { event: e });
            }}
          >
            {o.text ?? o.value}
          </button>
        );
        return o.tooltip ? (
          <Tooltip key={o.value} title={o.tooltip}>
            {btn}
          </Tooltip>
        ) : (
          btn
        );
      })}
    </div>
  );
}

// ───────────────────────── DatePicker ─────────────────────────

const DATE_FMT = 'YYYY-MM-DD';
const DATETIME_FMT = 'YYYY-MM-DDTHH:mm';

/**
 * Derive native min/max bounds from a `selectableDate` predicate by probing around today,
 * so the browser's picker greys out the right days. The predicate is still enforced on change.
 */
function probeBounds(selectableDate: ((d: Moment) => boolean) | undefined, withTime: boolean) {
  if (!selectableDate) return {};
  const fmt = withTime ? DATETIME_FMT : DATE_FMT;
  const today = moment().startOf('day');
  const yesterday = today.clone().subtract(1, 'day');
  const tomorrow = today.clone().add(1, 'day');
  if (!selectableDate(yesterday) && selectableDate(today)) return { min: today.format(fmt) };
  if (!selectableDate(today) && selectableDate(tomorrow)) return { min: tomorrow.format(fmt) };
  if (selectableDate(yesterday) && !selectableDate(tomorrow)) return { max: today.clone().endOf('day').format(fmt) };
  return {};
}

export interface DatePickerProps {
  value?: Moment | null;
  onChange?: (value: Moment, context: ChangeContext) => void;
  /** Return true for dates the user may pick. */
  selectableDate?: (date: Moment) => boolean;
  placeholder?: string;
  disabled?: boolean;
  className?: string;
  size?: ControlSize;
}

function DatePickerBase({ value, onChange, selectableDate, placeholder, disabled, className, size }: DatePickerProps) {
  return (
    <input
      type="date"
      className={cn('wf-input wf-datepicker', sizeClass('wf-input', size), !value && 'is-empty', className)}
      style={controlWidth(size ?? 'm')}
      value={value ? value.format(DATE_FMT) : ''}
      {...probeBounds(selectableDate, false)}
      placeholder={placeholder}
      aria-label={placeholder}
      disabled={disabled}
      onChange={(e) => {
        if (!e.target.value) return;
        const m = moment(e.target.value, DATE_FMT);
        if (!m.isValid() || (selectableDate && !selectableDate(m))) return;
        onChange?.(m, { event: e });
      }}
    />
  );
}

export interface RangePickerProps {
  value?: [Moment, Moment] | null;
  onChange?: (value: [Moment, Moment], context: ChangeContext) => void;
  /** Return true for dates the user may pick. */
  selectableDate?: (date: Moment) => boolean;
  /** Include a time of day (hours and minutes). */
  showTime?: boolean | { format?: string };
  separator?: ReactNode;
  disabled?: boolean;
  className?: string;
}

function RangePicker({ value, onChange, selectableDate, showTime, separator = '~', disabled, className }: RangePickerProps) {
  const withTime = !!showTime;
  const fmt = withTime ? DATETIME_FMT : DATE_FMT;
  const bounds = probeBounds(selectableDate, withTime);
  const [start, end] = value ?? [null, null];

  const emit = (which: 0 | 1, raw: string, e: React.ChangeEvent<HTMLInputElement>) => {
    if (!raw) return;
    const m = moment(raw, fmt);
    if (!m.isValid() || (selectableDate && !selectableDate(m))) return;
    let next: [Moment | null, Moment | null] = which === 0 ? [m, end] : [start, m];
    if (next[0] && next[1] && next[0].isAfter(next[1])) next = [next[1], next[0]];
    if (next[0] && next[1]) onChange?.([next[0], next[1]], { event: e });
  };

  const type = withTime ? 'datetime-local' : 'date';
  return (
    <div className={cn('wf-rangepicker', className)}>
      <input
        type={type}
        className="wf-input wf-datepicker"
        value={start ? start.format(fmt) : ''}
        {...bounds}
        disabled={disabled}
        onChange={(e) => emit(0, e.target.value, e)}
      />
      <span className="wf-rangepicker__sep">{separator}</span>
      <input
        type={type}
        className="wf-input wf-datepicker"
        value={end ? end.format(fmt) : ''}
        {...bounds}
        disabled={disabled}
        onChange={(e) => emit(1, e.target.value, e)}
      />
    </div>
  );
}

export const DatePicker = Object.assign(DatePickerBase, { RangePicker });

// ───────────────────────── Upload ─────────────────────────

export interface UploadProps {
  accept?: string;
  multiple?: boolean;
  disabled?: boolean;
  /** Called with the chosen file. Files are never uploaded by this component. */
  beforeUpload?: (file: File, fileList: File[], isAccepted: boolean, reasons: unknown[]) => boolean | Promise<unknown>;
  children?: ReactNode | ((props: { open: () => void; isDragging: boolean }) => ReactNode);
  className?: string;
}

function isAcceptedFile(file: File, accept?: string): boolean {
  if (!accept) return true;
  const name = file.name.toLowerCase();
  return accept
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .some((rule) =>
      rule.startsWith('.') ? name.endsWith(rule) : rule.endsWith('/*') ? file.type.startsWith(rule.slice(0, -1)) : file.type === rule,
    );
}

export function Upload({ accept, multiple, disabled, beforeUpload, children, className }: UploadProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  const open = () => {
    if (!disabled) inputRef.current?.click();
  };
  const content = typeof children === 'function' ? children({ open, isDragging: false }) : children;
  return (
    <span
      className={cn('wf-upload', className)}
      onClick={typeof children === 'function' ? undefined : open}
      role={typeof children === 'function' ? undefined : 'button'}
    >
      <input
        ref={inputRef}
        type="file"
        hidden
        accept={accept}
        multiple={multiple}
        onChange={(e) => {
          const files = Array.from(e.target.files ?? []);
          e.target.value = '';
          files.forEach((f) => void beforeUpload?.(f, files, isAcceptedFile(f, accept), []));
        }}
      />
      {content}
    </span>
  );
}
