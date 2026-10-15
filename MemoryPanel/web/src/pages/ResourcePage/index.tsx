/**
 * Generic shell of the resource management page - shared by Wiki / Code / Skills / Memory
 *
 * Content displays normally for both admin and member
 * The outer layer is wrapped by ConsoleLayout's Content.Body; here it is a direct child.
 */
import type { ReactNode } from 'react';
import './styles/page-style.css';

export function ResourcePage({ children }: { children: ReactNode }) {
  return (
    <div className="_memory-page-body">
      {children}
    </div>
  );
}
