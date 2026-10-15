import { useEffect, useState, type ReactNode } from 'react';
import { DirectionProvider } from '@radix-ui/react-direction';
import { Toaster } from 'sonner';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from './Tooltip';
import { ConfirmHost } from './confirm';

/**
 * App-wide UI context: reading direction (Hebrew is RTL), tooltip timing,
 * the toast stack and the confirm dialog host.
 */
export function UIProvider({ children }: { children: ReactNode }) {
  const { i18n } = useTranslation();
  const [dir, setDir] = useState<'ltr' | 'rtl'>(() => (i18n.dir(i18n.language) === 'rtl' ? 'rtl' : 'ltr'));

  useEffect(() => {
    const sync = (lng: string) => setDir(i18n.dir(lng) === 'rtl' ? 'rtl' : 'ltr');
    sync(i18n.language);
    i18n.on('languageChanged', sync);
    return () => i18n.off('languageChanged', sync);
  }, [i18n]);

  return (
    <DirectionProvider dir={dir}>
      <TooltipProvider delayDuration={250} skipDelayDuration={150}>
        {children}
        <ConfirmHost />
        <Toaster
          dir={dir}
          position={dir === 'rtl' ? 'top-left' : 'top-right'}
          richColors
          closeButton
          visibleToasts={4}
          toastOptions={{ className: 'wf-toast' }}
        />
      </TooltipProvider>
    </DirectionProvider>
  );
}
