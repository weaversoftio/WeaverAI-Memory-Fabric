import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import { Loader2 } from 'lucide-react';
import { cn } from './internal';
import { Tooltip } from './Tooltip';

export type ButtonType = 'default' | 'primary' | 'weak' | 'link' | 'text' | 'error' | 'icon' | 'pure';

export interface ButtonProps extends Omit<ButtonHTMLAttributes<HTMLButtonElement>, 'type'> {
  /** Visual style. */
  type?: ButtonType;
  /** Native button type (defaults to "button" so buttons never submit forms by accident). */
  htmlType?: 'button' | 'submit' | 'reset';
  loading?: boolean;
  /** Hover hint; also works on disabled buttons. */
  tooltip?: ReactNode;
  /** Leading icon. */
  icon?: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { type = 'default', htmlType = 'button', loading, tooltip, icon, disabled, className, children, ...rest },
  ref,
) {
  const iconOnly = !children && !!icon;
  const btn = (
    <button
      ref={ref}
      type={htmlType}
      disabled={disabled || loading}
      aria-busy={loading || undefined}
      className={cn('wf-btn', `wf-btn--${type}`, iconOnly && 'wf-btn--icon', loading && 'is-loading', className)}
      {...rest}
    >
      {loading ? <Loader2 className="wf-btn__spinner" size={14} aria-hidden /> : icon}
      {children}
    </button>
  );
  if (!tooltip) return btn;
  // Disabled buttons swallow pointer events, so the tooltip anchors on a wrapper.
  return (
    <Tooltip title={tooltip}>
      {disabled ? <span className="wf-btn__tooltip-wrap">{btn}</span> : btn}
    </Tooltip>
  );
});
