/**
 * Guide - step-by-step product tour bubble anchored to page elements.
 *
 * `current === -1` shows `startContent` (the welcome step). Navigation is fully controlled:
 * buttons call `onCurrentChange(next, { from })` and the caller decides when to advance.
 * The dimming mask is drawn by the caller; this component renders only the bubble.
 */
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Button } from './Button';
import { cn } from './internal';
import { splitPlacement, type Placement } from './Tooltip';

export interface GuideStep {
  element: () => Element | null;
  placement?: Placement;
  title?: ReactNode;
  description?: ReactNode;
}

type From = 'start' | 'back' | 'next' | 'finish' | 'cancel';

export interface GuideProps {
  visible?: boolean;
  steps: GuideStep[];
  startContent?: GuideStep;
  current: number;
  onCurrentChange: (next: number, context: { from: From }) => void;
  showBackButton?: boolean;
  showDot?: boolean;
  nextButtonTheme?: 'primary' | 'default';
  cancelText?: ReactNode;
  backText?: ReactNode;
  nextText?: ReactNode;
  finishText?: ReactNode;
  startFinishText?: ReactNode;
  autoScrollIntoView?: boolean;
}

export function Guide({
  visible,
  steps,
  startContent,
  current,
  onCurrentChange,
  showBackButton,
  showDot,
  nextButtonTheme = 'primary',
  cancelText,
  backText,
  nextText,
  finishText,
  startFinishText,
  autoScrollIntoView,
}: GuideProps) {
  const isStart = current < 0;
  const step = isStart ? startContent : steps[current];
  const isLast = current === steps.length - 1;
  const anchorRef = useRef<Element | null>(null);
  const [, force] = useState(0);

  // Resolve the anchor every render so it follows page changes.
  const element = visible && step ? step.element() : null;
  useLayoutEffect(() => {
    if (anchorRef.current !== element) {
      anchorRef.current = element;
      force((n) => n + 1);
    }
  });

  useEffect(() => {
    if (!visible || !autoScrollIntoView || !element || element === document.body) return;
    element.scrollIntoView({ behavior: 'smooth', block: 'nearest', inline: 'nearest' });
  }, [visible, autoScrollIntoView, element]);

  const virtualRef = useMemo(
    () => ({ current: { getBoundingClientRect: () => (anchorRef.current ?? document.body).getBoundingClientRect() } }),
    [],
  );

  if (!visible || !step) return null;
  const { side, align } = splitPlacement(step.placement ?? 'bottom-start');

  return (
    <Popover.Root open>
      <Popover.Anchor virtualRef={virtualRef} />
      <Popover.Portal>
        <Popover.Content
          className="wf-guide"
          side={side}
          align={align}
          sideOffset={12}
          collisionPadding={16}
          updatePositionStrategy="always"
          onOpenAutoFocus={(e) => e.preventDefault()}
          onEscapeKeyDown={() => onCurrentChange(current, { from: 'cancel' })}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="wf-guide__accent" aria-hidden />
          {step.title && <div className="wf-guide__title">{step.title}</div>}
          {step.description && <div className="wf-guide__description">{step.description}</div>}
          <div className="wf-guide__footer">
            {showDot && !isStart && (
              <div className="wf-guide__dots" aria-label={`${current + 1} / ${steps.length}`}>
                {steps.map((_, i) => (
                  <span key={i} className={cn('wf-guide__dot', i === current && 'is-active', i < current && 'is-done')} />
                ))}
              </div>
            )}
            <div className="wf-guide__btn-group">
              {!isLast && (
                <Button type="text" onClick={() => onCurrentChange(current, { from: 'cancel' })}>
                  {cancelText}
                </Button>
              )}
              {showBackButton && current > 0 && (
                <Button onClick={() => onCurrentChange(current - 1, { from: 'back' })}>{backText}</Button>
              )}
              {isStart ? (
                <Button type={nextButtonTheme} onClick={() => onCurrentChange(0, { from: 'start' })}>
                  {startFinishText ?? nextText}
                </Button>
              ) : isLast ? (
                <Button type={nextButtonTheme} onClick={() => onCurrentChange(current, { from: 'finish' })}>
                  {finishText}
                </Button>
              ) : (
                <Button type={nextButtonTheme} onClick={() => onCurrentChange(current + 1, { from: 'next' })}>
                  {nextText}
                </Button>
              )}
            </div>
          </div>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
