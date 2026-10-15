/**
 * Tea component bridge utilities
 *
 * Provides a convenient way to use Tea components in existing code,
 * gradually replacing native HTML elements and custom implementations.
 *
 * Usage:
 *   import { tea } from '@/lib/tea-bridge';
 *   tea.confirm({ message: 'Confirm delete?' }).then(ok => { ... });
 *   tea.notify.success('Operation succeeded');
 *   tea.notify.error('Load failed');  // Shows a notification card at the top right, must be closed manually, does not flash by
 *   tea.notify.error(err);  // Pass an Error / ApiError; message + request_id are extracted automatically
 */

import { getErrorMessage } from './error-message';
import { Modal, message, notification } from 'tea-component';
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

export const tea = {
  /**
   * Confirm dialog - replaces confirm()
   */
  confirm: async (opts: {
    message: string;
    description?: string;
    okText?: string;
    cancelText?: string;
  }) => {
    return Modal.confirm({
      message: opts.message,
      description: opts.description,
      okText: opts.okText ?? t('teaBridge.confirm.ok'),
      cancelText: opts.cancelText ?? t('teaBridge.confirm.cancel'),
    });
  },

  /**
   * Message notifications
   *
   * - success: lightweight toast (flashes by, does not interrupt the operation)
   * - error:   top-right notification card (must be closed manually, ensuring the user sees the error)
   * - warning:  top-right notification card (same as error, must be closed manually)
   * - info:     top-right notification card
   *
   * Previously error/warning used message.error (toast), which disappeared automatically after 3 seconds,
   * so users often missed the error. After switching to notification, the error
   * stays at the top right until the user closes it manually, so it is not overlooked.
   *
   * The error argument supports three forms:
   *   - string: used directly as the description
   *   - Error / ApiError / SkillApiError / KnowledgeApiError: message + request_id extracted automatically
   *   - StructuredErrorInput { title?, detail?, requestId? }: structured form
   */
  notify: {
    success: (msg: string) => message.success({ content: msg }),
    error: (msg: unknown) => {
      // Structured argument { title?, detail?, requestId? }
      if (msg && typeof msg === 'object' && !((msg as unknown) instanceof Error) && ('title' in msg || 'detail' in msg || 'requestId' in msg)) {
        const input = msg as StructuredErrorInput;
        const desc = input.requestId
          ? input.detail
            ? `${input.detail}\nrequest_id: ${input.requestId}`
            : `request_id: ${input.requestId}`
          : input.detail;
        notification.error({
          title: input.title ?? t('teaBridge.notify.errorTitle'),
          description: desc,
        });
        return;
      }
      // Error / string / other - use getErrorMessage to extract a friendly message
      const friendly = getErrorMessage(msg);
      const requestId = extractRequestId(msg);
      const desc = requestId
        ? `${friendly}\nrequest_id: ${requestId}`
        : friendly;
      notification.error({
        title: t('teaBridge.notify.errorTitle'),
        description: desc,
      });
    },
    warning: (msg: string) =>
      notification.warning({
        title: t('teaBridge.notify.warningTitle'),
        description: msg,
      }),
    info: (msg: string) =>
      notification.success({ description: msg }),
  },

  /**
   * Complex notification (with a custom title)
   */
  notification: {
    success: (title: string, description?: string) =>
      notification.success({ title, description }),
    error: (title: string, description?: string) =>
      notification.error({ title, description: description ? getErrorMessage(description) : undefined }),
    warning: (title: string, description?: string) =>
      notification.warning({ title, description }),
  },

  /**
   * Confirm delete
   */
  confirmDelete: (name: string, detail?: string) =>
    Modal.confirm({
      message: t('teaBridge.confirmDelete.message', { name }),
      description: detail ?? t('teaBridge.confirmDelete.desc'),
      okText: t('teaBridge.confirmDelete.ok'),
      cancelText: t('teaBridge.confirm.cancel'),
    }),
};

/**
 * "Run after confirm" helper - consolidates the many repeated
 * `tea.confirm(...) -> if (!ok) return -> try/catch -> tea.notify.error` boilerplates across asset pages.
 *
 * Runs the action after the user confirms; when the action throws, tea.notify.error(err) is used by default
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
  const ok = await tea.confirm(opts);
  if (!ok) return false;
  try {
    await action();
    return true;
  } catch (err) {
    if (onError) {
      onError(err);
    } else {
      tea.notify.error(err);
    }
    return false;
  }
}
