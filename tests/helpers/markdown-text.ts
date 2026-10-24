/**
 * @fileoverview Read the text a CommonMark client receives from tool content.
 * @module tests/helpers/markdown-text
 */
import MarkdownIt from 'markdown-it';

const markdown = new MarkdownIt({ html: true });

/** Decode inline markup while preserving authored text and hard breaks. */
export function markdownText(source: string): string {
  return markdown
    .parse(source, {})
    .flatMap((token) =>
      token.type === 'inline'
        ? (token.children ?? []).map((child) =>
            child.type === 'softbreak' || child.type === 'hardbreak' ? '\n' : child.content,
          )
        : [],
    )
    .join('\n');
}
