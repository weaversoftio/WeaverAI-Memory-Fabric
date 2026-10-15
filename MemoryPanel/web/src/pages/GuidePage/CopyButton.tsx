/**
 * CopyButton - a reusable "copy to clipboard" button within GuidePage.
 *
 * Extracted from GuidePage/index.tsx, shared by sub-modules such as quick start / memory instructions,
 * avoiding duplicate implementations of the copy logic and the copied-state feedback.
 *
 * The copy implementation reuses the project's unified copyToClipboard: prefer the Clipboard API in a secure context,
 * and in a non-secure context (a panel accessed via http:// + an intranet IP) automatically fall back to
 * the temporary textarea approach with document.execCommand('copy'), avoiding direct copy failure.
 */
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { feedback } from '@/lib/feedback';
import { copyToClipboard } from '@/pages/ChatMemoryPage/utils/memory-utils';

export function CopyButton({ value, label }: { value: string; label?: string }) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const copy = async () => {
    const ok = await copyToClipboard(value);
    if (ok) {
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } else {
      feedback.notify.error(t('guide.copyFailed'));
    }
  };
  return (
    <button type="button" className="guide-copy" onClick={copy}>
      {copied ? t('guide.copied') : (label ?? t('guide.copy'))}
    </button>
  );
}
