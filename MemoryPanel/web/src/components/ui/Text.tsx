import { createElement, type CSSProperties, type ReactNode } from 'react';
import { cn, plainText } from './internal';
import { Tooltip } from './Tooltip';
import { Copy } from './Copy';

export type TextTheme =
  | 'text'
  | 'primary'
  | 'label'
  | 'weak'
  | 'strong'
  | 'success'
  | 'warning'
  | 'danger'
  | 'cost'
  | 'disabled';

export interface TextProps {
  theme?: TextTheme;
  /** Element to render as. */
  parent?: 'span' | 'div' | 'p' | 'code' | 'label' | 'h1' | 'h2' | 'h3' | 'h4' | 'h5' | 'h6' | 'strong' | 'em';
  /** Truncate to one line with an ellipsis (full text shown on hover). */
  overflow?: boolean;
  tooltip?: ReactNode;
  /** Append a copy-to-clipboard control. `true` copies the text content. */
  copyable?: boolean | { text: string };
  /** Remove default margins. */
  reset?: boolean;
  className?: string;
  style?: CSSProperties;
  title?: string;
  onClick?: React.MouseEventHandler<HTMLElement>;
  children?: ReactNode;
}

export function Text({
  theme,
  parent = 'span',
  overflow,
  tooltip,
  copyable,
  reset,
  className,
  style,
  title,
  onClick,
  children,
}: TextProps) {
  const copyText = typeof copyable === 'object' ? copyable.text : copyable ? plainText(children) : undefined;
  const el = createElement(
    parent,
    {
      className: cn(
        'wf-text',
        theme && `wf-text--${theme}`,
        overflow && 'wf-text--overflow',
        parent === 'code' && 'wf-text--code',
        reset && 'wf-text--reset',
        className,
      ),
      style,
      onClick,
      title: title ?? (overflow && !tooltip ? plainText(children) : undefined),
    },
    children,
    copyText ? <Copy key="__copy" text={copyText} className="wf-text__copy" /> : null,
  );
  return tooltip ? <Tooltip title={tooltip}>{el}</Tooltip> : el;
}

export function H3({ className, children, style }: { className?: string; children?: ReactNode; style?: CSSProperties }) {
  return (
    <h3 className={cn('wf-heading wf-heading--3', className)} style={style}>
      {children}
    </h3>
  );
}
