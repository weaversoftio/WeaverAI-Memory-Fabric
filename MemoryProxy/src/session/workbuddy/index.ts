/**
 * Unified export for the WorkBuddy session-init layer.
 *
 * WARNING, independence rule: this barrel only exposes workbuddy's own types and entry points; it does not re-export
 * session-init content of other clients. The caller (workbuddyHandler) gets
 * all the necessary interfaces from here in one place.
 */

export {
  handleWorkbuddySessionInit,
  type WorkbuddySessionInitResult,
  type WorkbuddyRequestContext,
} from "./init.js";
