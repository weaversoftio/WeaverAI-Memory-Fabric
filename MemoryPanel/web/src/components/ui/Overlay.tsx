/**
 * Overlay components: Modal, Drawer, Dropdown, List, Select.
 */
import * as Dialog from '@radix-ui/react-dialog';
import * as Popover from '@radix-ui/react-popover';
import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Check, ChevronDown, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn, controlWidth, sizeClass, type ChangeContext, type ControlSize } from './internal';
import { splitPlacement, type Placement } from './Tooltip';

// ───────────────────────── Modal ─────────────────────────

const MODAL_WIDTH: Record<string, number> = { xs: 360, s: 480, m: 640, l: 800, xl: 1000 };

export interface ModalProps {
  visible?: boolean;
  caption?: ReactNode;
  size?: 'xs' | 's' | 'm' | 'l' | 'xl' | 'auto' | number;
  onClose?: () => void;
  /** Ignore Escape and outside clicks. */
  disableEscape?: boolean;
  disableCloseIcon?: boolean;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}

function ModalRoot({
  visible,
  caption,
  size = 'm',
  onClose,
  disableEscape,
  disableCloseIcon,
  className,
  style,
  children,
}: ModalProps) {
  const { t } = useTranslation();
  const width = typeof size === 'number' ? size : size === 'auto' ? undefined : MODAL_WIDTH[size];
  return (
    <Dialog.Root open={!!visible} onOpenChange={(open) => !open && onClose?.()}>
      <Dialog.Portal>
        <Dialog.Overlay className="wf-modal__overlay" />
        <Dialog.Content
          className={cn('wf-modal', className)}
          style={{ width: width ? `min(${width}px, calc(100vw - 32px))` : undefined, ...style }}
          aria-describedby={undefined}
          onEscapeKeyDown={(e) => disableEscape && e.preventDefault()}
          onPointerDownOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => e.preventDefault()}
        >
          <div className="wf-modal__header">
            <Dialog.Title className="wf-modal__title">{caption}</Dialog.Title>
            {!disableCloseIcon && onClose && (
              <Dialog.Close className="wf-modal__close" aria-label={t('ui.close')}>
                <X size={16} />
              </Dialog.Close>
            )}
          </div>
          {children}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const ModalBody = ({ className, children, style }: { className?: string; children?: ReactNode; style?: CSSProperties }) => (
  <div className={cn('wf-modal__body', className)} style={style}>
    {children}
  </div>
);
const ModalFooter = ({ className, children }: { className?: string; children?: ReactNode }) => (
  <div className={cn('wf-modal__footer', className)}>{children}</div>
);

export const Modal = Object.assign(ModalRoot, { Body: ModalBody, Footer: ModalFooter });

// ───────────────────────── Drawer ─────────────────────────

const DRAWER_WIDTH: Record<string, number> = { s: 420, m: 640, l: 880 };

export interface DrawerProps {
  visible?: boolean;
  title?: ReactNode;
  subtitle?: ReactNode;
  size?: 's' | 'm' | 'l';
  onClose?: () => void;
  footer?: ReactNode;
  /** Unmount children when closed (always true here; kept for API parity). */
  destroyOnClose?: boolean;
  showMask?: boolean;
  className?: string;
  children?: ReactNode;
}

export function Drawer({ visible, title, subtitle, size = 'm', onClose, footer, showMask = true, className, children }: DrawerProps) {
  const { t } = useTranslation();
  return (
    <Dialog.Root open={!!visible} onOpenChange={(open) => !open && onClose?.()} modal={showMask}>
      <Dialog.Portal>
        {showMask && <Dialog.Overlay className="wf-drawer__overlay" />}
        <Dialog.Content
          className={cn('wf-drawer', className)}
          style={{ width: `min(${DRAWER_WIDTH[size]}px, 100vw)` }}
          aria-describedby={undefined}
        >
          <div className="wf-drawer__header">
            <div className="wf-drawer__heading">
              <Dialog.Title className="wf-drawer__title">{title}</Dialog.Title>
              {subtitle && <div className="wf-drawer__subtitle">{subtitle}</div>}
            </div>
            <Dialog.Close className="wf-modal__close" aria-label={t('ui.close')}>
              <X size={16} />
            </Dialog.Close>
          </div>
          <div className="wf-drawer__body">{children}</div>
          {footer && <div className="wf-drawer__footer">{footer}</div>}
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

// ───────────────────────── Dropdown ─────────────────────────

export interface DropdownProps {
  /** Trigger content. With appearance="pure" it is rendered as-is. */
  button: ReactNode;
  children?: ReactNode | ((close: () => void) => ReactNode);
  appearance?: 'default' | 'button' | 'link' | 'filter' | 'pure';
  size?: ControlSize;
  placement?: Placement;
  /** Close after any click inside the panel (default true). */
  clickClose?: boolean;
  matchButtonWidth?: boolean;
  className?: string;
  boxClassName?: string;
  boxStyle?: CSSProperties;
  disabled?: boolean;
  onOpen?: () => void;
  onClose?: () => void;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  title?: string;
  tooltip?: ReactNode;
}

export function Dropdown({
  button,
  children,
  appearance = 'default',
  size,
  placement = 'bottom-start',
  clickClose = true,
  matchButtonWidth,
  className,
  boxClassName,
  boxStyle,
  disabled,
  onOpen,
  onClose,
  open: controlledOpen,
  onOpenChange,
  title,
}: DropdownProps) {
  const [innerOpen, setInnerOpen] = useState(false);
  const open = controlledOpen ?? innerOpen;
  const setOpen = (next: boolean) => {
    if (controlledOpen === undefined) setInnerOpen(next);
    onOpenChange?.(next);
    if (next) onOpen?.();
    else onClose?.();
  };
  const close = () => setOpen(false);
  const { side, align } = splitPlacement(placement);

  const trigger =
    appearance === 'pure' ? (
      <span className={cn('wf-dropdown wf-dropdown--pure', className)} title={title}>
        {button}
      </span>
    ) : (
      <button
        type="button"
        disabled={disabled}
        title={title}
        className={cn('wf-dropdown', `wf-dropdown--${appearance}`, sizeClass('wf-dropdown', size), open && 'is-open', className)}
        style={controlWidth(size)}
      >
        <span className="wf-dropdown__value">{button}</span>
        <ChevronDown className="wf-dropdown__arrow" size={14} aria-hidden />
      </button>
    );

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        {trigger}
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cn('wf-dropdown-box', matchButtonWidth && 'wf-dropdown-box--match', boxClassName)}
          style={boxStyle}
          onClick={(e) => {
            if (!clickClose) return;
            // Close when an actionable element inside was clicked.
            const target = e.target as HTMLElement;
            if (target.closest('button, a, [role="option"], [role="menuitem"], .wf-list__item')) close();
          }}
        >
          {typeof children === 'function' ? children(close) : children}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}

// ───────────────────────── List ─────────────────────────

function ListRoot({
  type = 'default',
  className,
  children,
  style,
}: {
  type?: 'default' | 'option' | 'checkbox' | 'bullet' | 'number';
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
}) {
  return (
    <ul role={type === 'option' ? 'menu' : undefined} className={cn('wf-list', `wf-list--${type}`, className)} style={style}>
      {children}
    </ul>
  );
}

function ListItem({
  onClick,
  selected,
  disabled,
  className,
  children,
  tooltip,
}: {
  onClick?: (e: React.MouseEvent) => void;
  selected?: boolean;
  disabled?: boolean;
  className?: string;
  tooltip?: string;
  children?: ReactNode;
}) {
  const interactive = !!onClick && !disabled;
  return (
    <li
      role={onClick ? 'menuitem' : undefined}
      tabIndex={interactive ? 0 : undefined}
      aria-disabled={disabled || undefined}
      title={tooltip}
      className={cn('wf-list__item', interactive && 'is-interactive', selected && 'is-selected', disabled && 'is-disabled', className)}
      onClick={(e) => interactive && onClick?.(e)}
      onKeyDown={(e) => {
        if (interactive && (e.key === 'Enter' || e.key === ' ')) {
          e.preventDefault();
          onClick?.(e as unknown as React.MouseEvent);
        }
      }}
    >
      <span className="wf-list__text">{children}</span>
      {selected && <Check className="wf-list__check" size={14} aria-hidden />}
    </li>
  );
}

export const List = Object.assign(ListRoot, { Item: ListItem });

// ───────────────────────── Select ─────────────────────────

export interface SelectOption {
  value: string;
  text?: ReactNode;
  disabled?: boolean;
  tooltip?: string;
  groupKey?: string;
}

export interface SelectProps {
  value?: string;
  onChange?: (value: string, context: ChangeContext & { option?: SelectOption }) => void;
  options?: SelectOption[];
  appearance?: 'default' | 'button' | 'link' | 'filter' | 'pure';
  size?: ControlSize;
  placeholder?: ReactNode;
  disabled?: boolean;
  matchButtonWidth?: boolean;
  /** Alias of matchButtonWidth. */
  boxSizeSync?: boolean;
  /** Width of the option list in px. */
  listWidth?: number;
  /** Show a filter box above the options. */
  searchable?: boolean;
  /** Custom trigger content. */
  button?: ReactNode | ((selected?: SelectOption) => ReactNode);
  className?: string;
  boxClassName?: string;
  style?: CSSProperties;
  placement?: Placement;
  tooltip?: string;
}

export function Select({
  value,
  onChange,
  options = [],
  appearance = 'default',
  size,
  placeholder,
  disabled,
  matchButtonWidth: matchButtonWidthProp,
  boxSizeSync,
  listWidth,
  searchable,
  button,
  className,
  boxClassName,
  style,
  placement = 'bottom-start',
  tooltip,
}: SelectProps) {
  const { t } = useTranslation();
  const matchButtonWidth = matchButtonWidthProp ?? boxSizeSync;
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const listRef = useRef<HTMLUListElement>(null);
  const selected = options.find((o) => o.value === value);
  const { side, align } = splitPlacement(placement);

  const visible = useMemo(() => {
    if (!searchable || !query) return options;
    const q = query.toLowerCase();
    return options.filter((o) => (typeof o.text === 'string' ? o.text : o.value).toLowerCase().includes(q));
  }, [options, query, searchable]);

  useEffect(() => {
    if (open) {
      setActive(Math.max(0, visible.findIndex((o) => o.value === value)));
    } else {
      setQuery('');
    }
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const pick = (o: SelectOption, e?: React.SyntheticEvent) => {
    if (o.disabled) return;
    setOpen(false);
    if (o.value !== value) onChange?.(o.value, { event: e, option: o });
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActive((i) => Math.min(visible.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter' && visible[active]) {
      e.preventDefault();
      pick(visible[active], e);
    }
  };

  const triggerContent =
    typeof button === 'function'
      ? button(selected)
      : button ??
        (selected ? (
          selected.text ?? selected.value
        ) : (
          <span className="wf-select__placeholder">{placeholder ?? t('ui.select.placeholder')}</span>
        ));

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild disabled={disabled}>
        <button
          type="button"
          role="combobox"
          aria-expanded={open}
          title={tooltip}
          disabled={disabled}
          className={cn(
            'wf-select wf-dropdown',
            `wf-dropdown--${appearance}`,
            sizeClass('wf-dropdown', size),
            open && 'is-open',
            className,
          )}
          style={{ ...controlWidth(size), ...style }}
          onKeyDown={(e) => {
            if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
              e.preventDefault();
              setOpen(true);
            }
          }}
        >
          <span className="wf-dropdown__value">{triggerContent}</span>
          <ChevronDown className="wf-dropdown__arrow" size={14} aria-hidden />
        </button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          side={side}
          align={align}
          sideOffset={4}
          collisionPadding={8}
          className={cn('wf-dropdown-box wf-select-box', matchButtonWidth && 'wf-dropdown-box--match', boxClassName)}
          style={listWidth ? { width: listWidth } : undefined}
          onKeyDown={onKeyDown}
          onOpenAutoFocus={(e) => {
            if (!searchable) {
              e.preventDefault();
              listRef.current?.focus();
            }
          }}
        >
          {searchable && (
            <div className="wf-select-box__search">
              <input
                autoFocus
                className="wf-input wf-input--full"
                value={query}
                placeholder={t('ui.search')}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                }}
              />
            </div>
          )}
          <ul ref={listRef} role="listbox" tabIndex={-1} className="wf-list wf-list--option wf-select-box__list">
            {visible.length === 0 && <li className="wf-select-box__empty">{t('ui.empty')}</li>}
            {visible.map((o, i) => (
              <li
                key={o.value}
                role="option"
                data-index={i}
                aria-selected={o.value === value}
                aria-disabled={o.disabled || undefined}
                title={o.tooltip}
                className={cn(
                  'wf-list__item is-interactive',
                  o.value === value && 'is-selected',
                  i === active && 'is-active',
                  o.disabled && 'is-disabled',
                )}
                onMouseEnter={() => setActive(i)}
                onClick={(e) => pick(o, e)}
              >
                <span className="wf-list__text">{o.text ?? o.value}</span>
                {o.value === value && <Check className="wf-list__check" size={14} aria-hidden />}
              </li>
            ))}
          </ul>
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
