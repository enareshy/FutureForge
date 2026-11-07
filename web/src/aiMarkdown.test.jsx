import { describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";

import AiMarkdown from "./aiMarkdown.jsx";

describe("AiMarkdown rendering", () => {
  it("renders headings, lists, code and emphasis as elements", () => {
    const { container } = render(
      <AiMarkdown text={"## Title\n\n- one\n- two\n\n```js\nconst x = 1;\n```\n\n**bold** and *italic*"} />,
    );

    expect(screen.getByRole("heading", { name: "Title" })).toBeInTheDocument();
    expect(screen.getAllByRole("listitem").map((n) => n.textContent)).toEqual(["one", "two"]);
    expect(container.querySelector("pre.ai-code code").textContent).toBe("const x = 1;");
    expect(container.querySelector("strong").textContent).toBe("bold");
    expect(container.querySelector("em").textContent).toBe("italic");
  });

  it("renders http(s) links with safe rel attributes", () => {
    render(<AiMarkdown text={"see [docs](https://example.com/x)"} />);

    const link = screen.getByRole("link", { name: "docs" });
    expect(link).toHaveAttribute("href", "https://example.com/x");
    expect(link).toHaveAttribute("target", "_blank");
    expect(link).toHaveAttribute("rel", "noopener noreferrer");
  });

  it("shows injected HTML as literal text instead of executing it", () => {
    const hostile = "<script>window.__pwned = true</script><img src=x onerror=alert(1)>";
    const { container } = render(<AiMarkdown text={hostile} />);

    expect(container.querySelector("script")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).toContain("<script>");
    expect(window.__pwned).toBeUndefined();
  });

  it("does not treat javascript: pseudo-links as links", () => {
    const { container } = render(<AiMarkdown text={"[click](javascript:alert(1))"} />);

    expect(container.querySelector("a")).toBeNull();
    expect(container.textContent).toContain("javascript:alert(1)");
  });
});
