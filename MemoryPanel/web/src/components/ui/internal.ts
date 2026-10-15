/**
 * Shared helpers for the WeaverAI UI kit.
 */
import clsx, { type ClassValue } from 'clsx';

export function cn(...inputs: ClassValue[]): string {
  return clsx(inputs);
}

/** Context passed as the second argument of controlled `onChange(value, context)` handlers. */
export interface ChangeContext<E = React.SyntheticEvent> {
  event?: E;
}

/**
 * Size vocabulary accepted by form controls.
 * `full` stretches to the container; the rest map to fixed widths.
 */
export type ControlSize = 'xs' | 's' | 'sm' | 'm' | 'l' | 'large' | 'xl' | 'full' | 'auto';

const CONTROL_WIDTH: Record<string, number | undefined> = {
  xs: 80,
  s: 120,
  sm: 160,
  m: 200,
  l: 320,
  large: 320,
  xl: 420,
};

/** Inline width style for a control size (undefined for full/auto, which are handled by class). */
export function controlWidth(size?: ControlSize | string): React.CSSProperties | undefined {
  if (!size || size === 'full' || size === 'auto') return undefined;
  const w = CONTROL_WIDTH[size];
  return w ? { width: w } : undefined;
}

export function sizeClass(base: string, size?: string): string | undefined {
  if (size === 'full') return `${base}--full`;
  if (size === 'auto') return `${base}--auto`;
  return undefined;
}

/** Text content of a node when it is a plain string/number (used for native title tooltips). */
export function plainText(node: React.ReactNode): string | undefined {
  if (typeof node === 'string') return node;
  if (typeof node === 'number') return String(node);
  return undefined;
}
