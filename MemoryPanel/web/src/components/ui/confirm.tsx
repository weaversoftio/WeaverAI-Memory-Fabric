/**
 * Imperative confirm dialog: `await confirmDialog({ message })` resolves true/false.
 * A single <ConfirmHost/> (mounted by UIProvider) renders the pending request.
 */
import { useSyncExternalStore, type ReactNode } from 'react';
import { TriangleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Modal } from './Overlay';
import { Button } from './Button';

export interface ConfirmOptions {
  message: ReactNode;
  description?: ReactNode;
  okText?: ReactNode;
  cancelText?: ReactNode;
  /** Style the confirm button as destructive. */
  danger?: boolean;
}

interface Pending extends ConfirmOptions {
  resolve: (ok: boolean) => void;
}

let current: Pending | null = null;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());

export function confirmDialog(options: ConfirmOptions): Promise<boolean> {
  // A new request supersedes an unanswered one.
  current?.resolve(false);
  return new Promise<boolean>((resolve) => {
    current = { ...options, resolve };
    emit();
  });
}

function settle(ok: boolean) {
  const p = current;
  current = null;
  emit();
  p?.resolve(ok);
}

export function ConfirmHost() {
  const { t } = useTranslation();
  const pending = useSyncExternalStore(
    (cb) => {
      listeners.add(cb);
      return () => listeners.delete(cb);
    },
    () => current,
  );
  return (
    <Modal visible={!!pending} size="xs" caption={null} onClose={() => settle(false)} className="wf-confirm">
      {pending && (
        <>
          <Modal.Body>
            <div className="wf-confirm__row">
              <span className={pending.danger ? 'wf-confirm__icon is-danger' : 'wf-confirm__icon'}>
                <TriangleAlert size={18} />
              </span>
              <div>
                <div className="wf-confirm__message">{pending.message}</div>
                {pending.description && <div className="wf-confirm__description">{pending.description}</div>}
              </div>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button onClick={() => settle(false)}>{pending.cancelText ?? t('feedback.confirm.cancel')}</Button>
            <Button type={pending.danger ? 'error' : 'primary'} autoFocus onClick={() => settle(true)}>
              {pending.okText ?? t('feedback.confirm.ok')}
            </Button>
          </Modal.Footer>
        </>
      )}
    </Modal>
  );
}
