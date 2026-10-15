/**
 * Display components: Card, Alert, Tag, Justify, StatusTip, Status, MetricsBoard, Progress, Avatar.
 */
import { type CSSProperties, type ReactNode } from 'react';
import {
  AlertCircle,
  CheckCircle2,
  Info,
  Inbox,
  Loader2,
  SearchX,
  TriangleAlert,
  WifiOff,
  Lock,
  BarChart3,
  Upload as UploadIcon,
  X,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './internal';

// ───────────────────────── Card ─────────────────────────

export interface CardProps {
  bordered?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
  onClick?: React.MouseEventHandler<HTMLDivElement>;
}

function CardRoot({ bordered, className, style, children, onClick }: CardProps) {
  return (
    <div className={cn('wf-card', bordered && 'wf-card--bordered', className)} style={style} onClick={onClick}>
      {children}
    </div>
  );
}

export interface CardBodyProps {
  title?: ReactNode;
  subtitle?: ReactNode;
  /** Actions shown at the end of the header row. */
  operation?: ReactNode;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

function CardBody({ title, subtitle, operation, className, style, children }: CardBodyProps) {
  return (
    <div className={cn('wf-card__body', className)} style={style}>
      {(title || subtitle || operation) && (
        <div className="wf-card__header">
          <div className="wf-card__heading">
            {title && <h3 className="wf-card__title">{title}</h3>}
            {subtitle && <div className="wf-card__subtitle">{subtitle}</div>}
          </div>
          {operation && <div className="wf-card__operation">{operation}</div>}
        </div>
      )}
      <div className="wf-card__content">{children}</div>
    </div>
  );
}

function CardFooter({ className, children }: { className?: string; children?: ReactNode }) {
  return <div className={cn('wf-card__footer', className)}>{children}</div>;
}

export const Card = Object.assign(CardRoot, { Body: CardBody, Footer: CardFooter });

// ───────────────────────── Alert ─────────────────────────

export type AlertType = 'info' | 'success' | 'warning' | 'error';

const ALERT_ICON: Record<AlertType, ReactNode> = {
  info: <Info size={16} />,
  success: <CheckCircle2 size={16} />,
  warning: <TriangleAlert size={16} />,
  error: <AlertCircle size={16} />,
};

export interface AlertProps {
  type?: AlertType;
  /** Optional bold first line. */
  title?: ReactNode;
  /** Actions shown after the message. */
  extra?: ReactNode;
  onClose?: () => void;
  hideIcon?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

export function Alert({ type = 'info', title, extra, onClose, hideIcon, className, style, children }: AlertProps) {
  const { t } = useTranslation();
  return (
    <div
      role={type === 'error' || type === 'warning' ? 'alert' : 'status'}
      className={cn('wf-alert', `wf-alert--${type}`, className)}
      style={style}
    >
      {!hideIcon && <span className="wf-alert__icon">{ALERT_ICON[type]}</span>}
      <div className="wf-alert__body">
        {title && <div className="wf-alert__title">{title}</div>}
        <div className="wf-alert__content">{children}</div>
        {extra && <div className="wf-alert__extra">{extra}</div>}
      </div>
      {onClose && (
        <button type="button" className="wf-alert__close" aria-label={t('ui.close')} onClick={onClose}>
          <X size={14} />
        </button>
      )}
    </div>
  );
}

// ───────────────────────── Tag ─────────────────────────

export type TagTheme = 'default' | 'primary' | 'success' | 'warning' | 'error' | 'danger' | 'info';

export interface TagProps {
  theme?: TagTheme;
  variant?: 'default' | 'soft' | 'outlined' | 'filled';
  size?: 'sm' | 's' | 'm' | 'default';
  onClose?: () => void;
  className?: string;
  style?: CSSProperties;
  title?: string;
  children?: ReactNode;
}

export function Tag({ theme = 'default', variant = 'soft', size, onClose, className, style, title, children }: TagProps) {
  const th = theme === 'danger' ? 'error' : theme;
  return (
    <span
      className={cn('wf-tag', `wf-tag--${th}`, `wf-tag--${variant}`, (size === 'sm' || size === 's') && 'wf-tag--sm', className)}
      style={style}
      title={title}
    >
      {children}
      {onClose && (
        <button type="button" className="wf-tag__close" onClick={onClose} aria-label="remove">
          <X size={10} />
        </button>
      )}
    </span>
  );
}

// ───────────────────────── Justify ─────────────────────────

export interface JustifyProps {
  left?: ReactNode;
  right?: ReactNode;
  className?: string;
  style?: CSSProperties;
}

export function Justify({ left, right, className, style }: JustifyProps) {
  return (
    <div className={cn('wf-justify', className)} style={style}>
      <div className="wf-justify__col wf-justify__col--left">{left}</div>
      <div className="wf-justify__col wf-justify__col--right">{right}</div>
    </div>
  );
}

// ───────────────────────── StatusTip ─────────────────────────

export interface StatusTipProps {
  status?: 'loading' | 'empty' | 'found' | 'none' | 'error' | string;
  loadingText?: ReactNode;
  emptyText?: ReactNode;
  foundText?: ReactNode;
  errorText?: ReactNode;
  onRetry?: () => void;
  className?: string;
  style?: CSSProperties;
}

/** Inline loading / empty / error state for lists and panels. */
export function StatusTip({
  status = 'none',
  loadingText,
  emptyText,
  foundText,
  errorText,
  onRetry,
  className,
  style,
}: StatusTipProps) {
  const { t } = useTranslation();
  if (status === 'none') return null;
  let icon: ReactNode = null;
  let text: ReactNode = null;
  if (status === 'loading') {
    icon = <Loader2 className="wf-spin" size={16} />;
    text = loadingText ?? t('ui.loading');
  } else if (status === 'empty') {
    icon = <Inbox size={16} />;
    text = emptyText ?? t('ui.empty');
  } else if (status === 'found') {
    icon = <SearchX size={16} />;
    text = foundText ?? t('ui.noMatch');
  } else if (status === 'error') {
    icon = <AlertCircle size={16} />;
    text = errorText ?? t('ui.loadFailed');
  } else {
    return null;
  }
  return (
    <div className={cn('wf-status-tip', `wf-status-tip--${status}`, className)} style={style}>
      {icon}
      <span>{text}</span>
      {status === 'error' && onRetry && (
        <button type="button" className="wf-link-btn" onClick={onRetry}>
          {t('ui.retry')}
        </button>
      )}
    </div>
  );
}

// ───────────────────────── Status (large empty state) ─────────────────────────

const STATUS_ICON: Record<string, ReactNode> = {
  blank: <Inbox size={36} strokeWidth={1.5} />,
  chart: <BarChart3 size={36} strokeWidth={1.5} />,
  loading: <Loader2 className="wf-spin" size={36} strokeWidth={1.5} />,
  network: <WifiOff size={36} strokeWidth={1.5} />,
  'no-permission': <Lock size={36} strokeWidth={1.5} />,
  search: <SearchX size={36} strokeWidth={1.5} />,
  upload: <UploadIcon size={36} strokeWidth={1.5} />,
};

export interface StatusProps {
  icon?: 'blank' | 'chart' | 'loading' | 'network' | 'no-permission' | 'pay' | 'search' | 'upload';
  size?: 'l' | 'm' | 's' | 'xs';
  title?: ReactNode;
  description?: ReactNode;
  operation?: ReactNode;
  className?: string;
}

export function Status({ icon = 'blank', size = 'm', title, description, operation, className }: StatusProps) {
  return (
    <div className={cn('wf-status', `wf-status--${size}`, className)}>
      <div className="wf-status__icon">{STATUS_ICON[icon] ?? STATUS_ICON.blank}</div>
      {title && <div className="wf-status__title">{title}</div>}
      {description && <div className="wf-status__description">{description}</div>}
      {operation && <div className="wf-status__operation">{operation}</div>}
    </div>
  );
}

// ───────────────────────── MetricsBoard ─────────────────────────

export interface MetricsBoardProps {
  title: ReactNode;
  value: ReactNode;
  unit?: ReactNode;
  infos?: ReactNode[];
  className?: string;
  onClick?: () => void;
}

function MetricsBoardRoot({ title, value, unit, infos, className, onClick }: MetricsBoardProps) {
  return (
    <div className={cn('wf-metrics', onClick && 'is-clickable', className)} onClick={onClick}>
      <div className="wf-metrics__title">{title}</div>
      <div className="wf-metrics__value">
        {value}
        {unit && <span className="wf-metrics__unit">{unit}</span>}
      </div>
      {infos && infos.length > 0 && (
        <div className="wf-metrics__infos">
          {infos.map((info, i) => (
            <div key={i} className="wf-metrics__info">
              {info}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

const InfoLabel = ({ children }: { children?: ReactNode }) => <span className="wf-metrics__info-label">{children}</span>;
const InfoKey = ({ children }: { children?: ReactNode }) => <span className="wf-metrics__info-key">{children}</span>;

export const MetricsBoard = Object.assign(MetricsBoardRoot, { InfoLabel, InfoKey });

// ───────────────────────── Progress ─────────────────────────

export function Progress({
  percent = 0,
  theme = 'default',
  className,
  hideText,
}: {
  percent?: number;
  theme?: 'default' | 'success' | 'warning' | 'danger';
  className?: string;
  hideText?: boolean;
}) {
  const p = Math.max(0, Math.min(100, Math.round(percent)));
  return (
    <div className={cn('wf-progress', `wf-progress--${theme}`, className)}>
      <div className="wf-progress__track" role="progressbar" aria-valuenow={p} aria-valuemin={0} aria-valuemax={100}>
        <div className="wf-progress__bar" style={{ width: `${p}%` }} />
      </div>
      {!hideText && <span className="wf-progress__text">{p}%</span>}
    </div>
  );
}

// ───────────────────────── Avatar ─────────────────────────

const AVATAR_PALETTE = ['#2563eb', '#0ea5e9', '#7c3aed', '#f2785c', '#16a34a', '#d97706', '#db2777', '#0d9488'];

function hashColor(seed: string): string {
  let h = 0;
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0;
  return AVATAR_PALETTE[Math.abs(h) % AVATAR_PALETTE.length];
}

export function Avatar({
  text,
  color,
  width = 32,
  height,
  className,
}: {
  text?: ReactNode;
  /** Explicit CSS color, or any string used as a seed for a stable brand color. */
  color?: string;
  width?: number;
  height?: number;
  className?: string;
}) {
  const bg = color && /^(#|rgb|hsl)/.test(color) ? color : hashColor(color ?? String(text ?? ''));
  const h = height ?? width;
  return (
    <span
      className={cn('wf-avatar', className)}
      style={{ width, height: h, background: bg, fontSize: Math.round(Math.min(width, h) * 0.42) }}
    >
      {text}
    </span>
  );
}
