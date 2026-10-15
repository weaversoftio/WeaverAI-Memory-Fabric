/**
 * User feedback helpers: confirm dialogs and notifications.
 *
 * Usage:
 *   import { feedback } from '@/lib/feedback';
 *   feedback.confirm({ message: 'Confirm delete?' }).then(ok => { ... });
 *   feedback.notify.success('Operation succeeded');
 *   feedback.notify.error('Load failed');  // Stays on screen until closed, so errors are not missed
 *   feedback.notify.error(err);  // Pass an Error / ApiError; message + request_id are extracted automatically
 */

import { toast } from 'sonner';
import { getErrorMessage } from './error-message';
import { confirmDialog } from '@/components/ui/confirm';
import i18n from '@/i18n';

function t(key: string, opts?: Record<string, unknown>): string {
  return i18n.t(key, opts);
}

/**
 * Structured error notification input - for scenarios that need to show title + detail + requestId.
 */
interface StructuredErrorInput {
  title?: string;
  detail?: string;
  requestId?: string;
}

/**
 * Best-effort extraction of request_id from an unknown error object.
 * Supports ApiError (name === 'ApiError'), SkillApiError, KnowledgeApiError, etc.
 */
function extractRequestId(err: unknown): string | undefined {
  if (err && typeof err === 'object' && 'requestId' in err) {
    const v = (err as { requestId?: unknown }).requestId;
    if (typeof v === 'string' && v) return v;
  }
  if (err && typeof err === 'object' && 'request_id' in err) {
    const v = (err as { request_id?: unknown }).request_id;
    if (typeof v === 'string' && v) return v;
  }
  return undefined;
}

/** Errors and warnings stay until dismissed; success/info toasts fade out. */
const STICKY = { duration: Infinity } as const;

export const feedback = {
  /**
   * Confirm dialog - replaces confirm()
   */
  confirm: async (opts: { message: string; description?: string; okText?: string; cancelText?: string }) =>
    confirmDialog({
      message: opts.message,
      description: opts.description,
      okText: opts.okText ?? t('feedback.confirm.ok'),
      cancelText: opts.cancelText ?? t('feedback.confirm.cancel'),
    }),

  /**
   * Message notifications
   *
   * - success: lightweight toast (fades out, does not interrupt the operation)
   * - error:   stays until closed, ensuring the user sees the error
   * - warning: stays until closed
   * - info:    lightweight toast
   *
   * The error argument supports three forms:
   *   - string: used directly as the description
   *   - Error / ApiError / SkillApiError / KnowledgeApiError: message + request_id extracted automatically
   *   - StructuredErrorInput { title?, detail?, requestId? }: structured form
   */
  notify: {
    success: (msg: string) => {
      toast.success(msg);
    },
    error: (msg: unknown) => {
      // Structured argument { title?, detail?, requestId? }
      if (
        msg &&
        typeof msg === 'object' &&
        !((msg as unknown) instanceof Error) &&
        ('title' in msg || 'detail' in msg || 'requestId' in msg)
      ) {
        const input = msg as StructuredErrorInput;
        const desc = input.requestId
          ? input.detail
            ? `${input.detail}\nrequest_id: ${input.requestId}`
            : `request_id: ${input.requestId}`
          : input.detail;
        toast.error(input.title ?? t('feedback.notify.errorTitle'), { description: desc, ...STICKY });
        return;
      }
      // Error / string / other - use getErrorMessage to extract a friendly message
      const friendly = getErrorMessage(msg);
      const requestId = extractRequestId(msg);
      const desc = requestId ? `${friendly}\nrequest_id: ${requestId}` : friendly;
      toast.error(t('feedback.notify.errorTitle'), { description: desc, ...STICKY });
    },
    warning: (msg: string) => {
      toast.warning(t('feedback.notify.warningTitle'), { description: msg, ...STICKY });
    },
    info: (msg: string) => {
      toast.info(msg);
    },
  },

  /**
   * Notification with a custom title
   */
  notification: {
    success: (title: string, description?: string) => {
      toast.success(title, { description });
    },
    error: (title: string, description?: string) => {
      toast.error(title, { description: description ? getErrorMessage(description) : undefined, ...STICKY });
    },
    warning: (title: string, description?: string) => {
      toast.warning(title, { description, ...STICKY });
    },
  },

  /**
   * Confirm delete
   */
  confirmDelete: (name: string, detail?: string) =>
    confirmDialog({
      message: t('feedback.confirmDelete.message', { name }),
      description: detail ?? t('feedback.confirmDelete.desc'),
      okText: t('feedback.confirmDelete.ok'),
      cancelText: t('feedback.confirm.cancel'),
      danger: true,
    }),
};

/**
 * "Run after confirm" helper - consolidates the repeated
 * `feedback.confirm(...) -> if (!ok) return -> try/catch -> feedback.notify.error` pattern across asset pages.
 *
 * Runs the action after the user confirms; when the action throws, feedback.notify.error(err) is used by default
 * (pass onError to customize the error hint, e.g. with an i18n fallback message).
 *
 * @returns whether the user confirmed and the action ran successfully (false on cancel or failure)
 */
export async function confirmThenRun(
  opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  },
  action: () => Promise<void> | void,
  onError?: (err: unknown) => void,
): Promise<boolean> {
  const ok = await feedback.confirm(opts);
  if (!ok) return false;
  try {
    await action();
    return true;
  } catch (err) {
    if (onError) {
      onError(err);
    } else {
      feedback.notify.error(err);
    }
    return false;
  }
}
