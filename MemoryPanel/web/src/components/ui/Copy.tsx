import { isValidElement, cloneElement, useState, type ReactElement, type ReactNode } from 'react';
import { Check, Copy as CopyIcon } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from './internal';
import { Tooltip } from './Tooltip';

export interface CopyProps {
  text: string;
  onCopy?: (text: string, context: { event: React.MouseEvent }) => void;
  /** Custom trigger. A function receives whether the text was just copied. */
  children?: ReactNode | ((copied: boolean) => ReactNode);
  className?: string;
}

async function writeClipboard(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    // Fallback for non-secure contexts (plain http on a LAN host).
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.setAttribute('readonly', '');
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    document.body.removeChild(ta);
  }
}

/** Copy-to-clipboard trigger. Renders an icon button unless children are given. */
export function Copy({ text, onCopy, children, className }: CopyProps) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);

  const handle = async (event: React.MouseEvent) => {
    event.stopPropagation();
    await writeClipboard(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
    onCopy?.(text, { event });
  };

  const content = typeof children === 'function' ? children(copied) : children;

  if (content !== undefined && content !== null) {
    if (isValidElement(content)) {
      const el = content as ReactElement<{ onClick?: (e: React.MouseEvent) => void }>;
      return cloneElement(el, {
        onClick: (e: React.MouseEvent) => {
          el.props.onClick?.(e);
          void handle(e);
        },
      });
    }
    return (
      <span role="button" tabIndex={0} className={cn('wf-copy', className)} onClick={(e) => void handle(e)}>
        {content}
      </span>
    );
  }

  return (
    <Tooltip title={copied ? t('ui.copy.copied') : t('ui.copy.copy')}>
      <button
        type="button"
        className={cn('wf-copy wf-copy--icon', copied && 'is-copied', className)}
        aria-label={t('ui.copy.copy')}
        onClick={(e) => void handle(e)}
      >
        {copied ? <Check size={14} /> : <CopyIcon size={14} />}
      </button>
    </Tooltip>
  );
}
