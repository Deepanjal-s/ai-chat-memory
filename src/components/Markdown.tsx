import ReactMarkdown from 'react-markdown'
import remarkGfm from 'remark-gfm'

/** Renders conversation text. Raw HTML in messages is never rendered (react-markdown escapes it). */
export function Markdown({ text }: { text: string }) {
  return (
    <div className="prose-chat text-[15px] text-ink">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => (
            <a href={href} target="_blank" rel="noopener noreferrer nofollow">
              {children}
            </a>
          ),
          img: ({ alt }) => <span className="text-ink-3">[image{alt ? `: ${alt}` : ''}]</span>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  )
}
