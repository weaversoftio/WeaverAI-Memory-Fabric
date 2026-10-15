/**
 * MarkdownView — unified Markdown rendering component.
 *
 * Pages such as Skill details / Memory details share one rendering and display style:
 * ReactMarkdown + remark-gfm, with a Tea token bordered box as the shell
 * (see markdown-view.css), not using tailwind semantic colors or inline style.
 */

import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import './markdown-view.css';

export function MarkdownView({ children, className, bare }: { children: string; className?: string; bare?: boolean }) {
  return (
    <div className={`_md-view${bare ? ' _md-view--bare' : ''} prose prose-slate max-w-none${className ? ` ${className}` : ''}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]}>{children}</ReactMarkdown>
    </div>
  );
}
