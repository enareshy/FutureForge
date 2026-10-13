import React, { useMemo } from "react";

// A deliberately small, safe Markdown renderer for AI output.
//
// Model output is untrusted input. This renderer never uses
// `dangerouslySetInnerHTML`; it builds React elements and renders every piece
// of source text as a string node. It supports only a safe subset of Markdown
// (headings, lists, fenced/inline code, bold/italic, blockquotes and http(s)
// links) so that injected HTML or scripts are shown as literal text.

const INLINE_RE = /(`[^`]+`)|(\*\*[^*]+\*\*)|(\*[^*]+\*)|(\[([^\]]+)\]\((https?:\/\/[^\s)]+)\))/g;

function renderInline(text, keyPrefix) {
  const nodes = [];
  let last = 0;
  let match;
  let idx = 0;
  const re = new RegExp(INLINE_RE.source, "g");
  while ((match = re.exec(text)) !== null) {
    if (match.index > last) nodes.push(text.slice(last, match.index));
    const token = match[0];
    const key = `${keyPrefix}-i${idx++}`;
    if (token.startsWith("`")) {
      nodes.push(<code key={key}>{token.slice(1, -1)}</code>);
    } else if (token.startsWith("**")) {
      nodes.push(<strong key={key}>{token.slice(2, -2)}</strong>);
    } else if (token.startsWith("*")) {
      nodes.push(<em key={key}>{token.slice(1, -1)}</em>);
    } else if (match[3]) {
      nodes.push(
        <a key={key} href={match[3]} target="_blank" rel="noopener noreferrer">
          {match[2]}
        </a>
      );
    }
    last = match.index + token.length;
  }
  if (last < text.length) nodes.push(text.slice(last));
  return nodes;
}

function isBlockStart(line) {
  return (
    !line.trim() ||
    line.startsWith("```") ||
    /^(#{1,6})\s+/.test(line) ||
    /^\s*[-*+]\s+/.test(line) ||
    /^\s*\d+\.\s+/.test(line) ||
    /^\s*>\s?/.test(line)
  );
}

function parseBlocks(text) {
  const lines = text.replace(/\r\n/g, "\n").split("\n");
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (line.startsWith("```")) {
      const lang = line.slice(3).trim();
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++;
      blocks.push({ type: "code", lang, text: buf.join("\n") });
      continue;
    }
    if (!line.trim()) {
      i++;
      continue;
    }
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      blocks.push({ type: "heading", level: heading[1].length, text: heading[2] });
      i++;
      continue;
    }
    if (/^\s*[-*+]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*+]\s+/, ""));
        i++;
      }
      blocks.push({ type: "ul", items });
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, ""));
        i++;
      }
      blocks.push({ type: "ol", items });
      continue;
    }
    if (/^\s*>\s?/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
        buf.push(lines[i].replace(/^\s*>\s?/, ""));
        i++;
      }
      blocks.push({ type: "quote", text: buf.join("\n") });
      continue;
    }
    const buf = [line];
    i++;
    while (i < lines.length && !isBlockStart(lines[i])) {
      buf.push(lines[i]);
      i++;
    }
    blocks.push({ type: "p", lines: buf });
  }
  return blocks;
}

function Paragraph({ lines, keyPrefix }) {
  const children = [];
  lines.forEach((line, i) => {
    if (i > 0) children.push(<br key={`${keyPrefix}-br${i}`} />);
    renderInline(line, `${keyPrefix}-l${i}`).forEach((node, j) => {
      if (typeof node === "string") children.push(node);
      else children.push(React.cloneElement(node, { key: `${keyPrefix}-l${i}-${j}` }));
    });
  });
  return <p>{children}</p>;
}

export default function AiMarkdown({ text, className }) {
  const blocks = useMemo(() => parseBlocks(String(text ?? "")), [text]);
  return (
    <div className={`ai-markdown${className ? ` ${className}` : ""}`}>
      {blocks.map((block, index) => {
        const key = `b${index}`;
        switch (block.type) {
          case "code":
            return (
              <pre key={key} className="ai-code">
                <code>{block.text}</code>
              </pre>
            );
          case "heading": {
            const Tag = `h${Math.min(block.level + 1, 6)}`;
            return <Tag key={key}>{renderInline(block.text, key)}</Tag>;
          }
          case "ul":
            return (
              <ul key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ul>
            );
          case "ol":
            return (
              <ol key={key}>
                {block.items.map((item, i) => (
                  <li key={`${key}-${i}`}>{renderInline(item, `${key}-${i}`)}</li>
                ))}
              </ol>
            );
          case "quote":
            return (
              <blockquote key={key} className="ai-quote">
                {renderInline(block.text, key)}
              </blockquote>
            );
          default:
            return <Paragraph key={key} lines={block.lines} keyPrefix={key} />;
        }
      })}
    </div>
  );
}
