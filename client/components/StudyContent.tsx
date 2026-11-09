import { memo } from "react";
import Markdown from "react-markdown";
import remarkMath from "remark-math";
import remarkGfm from "remark-gfm";
import rehypeKatex from "rehype-katex";
import "katex/contrib/mhchem";
const remarkPlugins = [remarkMath, remarkGfm];
const rehypePlugins: NonNullable<
  Parameters<typeof Markdown>[0]["rehypePlugins"]
> = [
  [
    rehypeKatex,
    {
      trust: false,
      strict: "warn",
      throwOnError: false,
      maxExpand: 1000,
      maxSize: 20,
      errorColor: "#FF8F8F",
    },
  ],
];
export const StudyContent = memo(function StudyContent({
  source,
  label,
}: {
  source?: string;
  label?: string;
}) {
  if (!source) return null;
  return (
    <div className="study-content" aria-label={label}>
      <Markdown
        remarkPlugins={remarkPlugins}
        rehypePlugins={rehypePlugins}
        skipHtml
        disallowedElements={[
          "img",
          "iframe",
          "video",
          "audio",
          "object",
          "embed",
        ]}
        urlTransform={(url) => (/^https?:\/\//i.test(url) ? url : "")}
        components={{
          pre: ({ node: _node, ...props }) => <pre {...props} tabIndex={0} />,
          table: ({ node: _node, ...props }) => (
            <div
              className="study-table-scroll"
              tabIndex={0}
              role="region"
              aria-label="Study table"
            >
              <table {...props} />
            </div>
          ),
          a: ({ children, ...props }) => (
            <a {...props} target="_blank" rel="noopener noreferrer">
              {children}
            </a>
          ),
          span: ({ children, className, ...props }) =>
            className?.includes("katex-error") ? (
              <span className="math-warning" role="status" {...props}>
                Formula warning{label ? ` in ${label}` : ""}: {children}
              </span>
            ) : (
              <span className={className} {...props}>
                {children}
              </span>
            ),
        }}
      >
        {source}
      </Markdown>
    </div>
  );
});
