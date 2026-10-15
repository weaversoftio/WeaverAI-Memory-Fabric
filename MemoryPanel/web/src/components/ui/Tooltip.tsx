import * as RT from '@radix-ui/react-tooltip';
import { isValidElement, type ReactElement, type ReactNode } from 'react';

export type Placement =
  | 'top'
  | 'bottom'
  | 'left'
  | 'right'
  | 'top-start'
  | 'top-end'
  | 'bottom-start'
  | 'bottom-end'
  | 'left-start'
  | 'left-end'
  | 'right-start'
  | 'right-end'
  | 'auto';

export function splitPlacement(p?: Placement): {
  side: 'top' | 'bottom' | 'left' | 'right';
  align: 'start' | 'center' | 'end';
} {
  if (!p || p === 'auto') return { side: 'bottom', align: 'start' };
  const [side, align] = p.split('-') as ['top' | 'bottom' | 'left' | 'right', 'start' | 'end' | undefined];
  return { side, align: align ?? 'center' };
}

export interface TooltipProps {
  title?: ReactNode;
  placement?: Placement;
  children: ReactNode;
  /** Open delay in ms. */
  openDelay?: number;
}

/**
 * Hover tooltip. When `title` is empty the children render untouched.
 * Non-element children are wrapped in a span so they can act as the trigger.
 */
export function Tooltip({ title, placement = 'top', children, openDelay = 250 }: TooltipProps) {
  if (title === undefined || title === null || title === '' || title === false) return <>{children}</>;
  const { side, align } = splitPlacement(placement);
  // Host elements (button, div, span...) take the trigger ref directly; components and text get a span anchor.
  const isHostElement = isValidElement(children) && typeof (children as ReactElement).type === 'string';
  const trigger: ReactElement = isHostElement ? (
    (children as ReactElement)
  ) : (
    <span className="wf-tooltip__anchor">{children}</span>
  );
  return (
    <RT.Root delayDuration={openDelay}>
      <RT.Trigger asChild>{trigger}</RT.Trigger>
      <RT.Portal>
        <RT.Content className="wf-tooltip" side={side} align={align} sideOffset={6} collisionPadding={8}>
          {title}
          <RT.Arrow className="wf-tooltip__arrow" width={10} height={5} />
        </RT.Content>
      </RT.Portal>
    </RT.Root>
  );
}

export const TooltipProvider = RT.Provider;
