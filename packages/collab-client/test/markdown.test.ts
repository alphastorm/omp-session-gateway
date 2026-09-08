import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../upstream/src/components/transcript/Markdown";

function renderMarkdown(text: string): string {
  return renderToStaticMarkup(createElement(Markdown, { text }));
}

describe("transcript Markdown", () => {
  test("preserves assistant soft line breaks for tree-shaped prose", () => {
    const html = renderMarkdown(
      "요청 요지\n├── 현재 collab guest는 텍스트 prompt는 보낼 수 있음\n└── 빠진 것은 guest → host 방향의 이미지 업로드/첨부 입력 경로임",
    );

    expect(html).toContain("요청 요지<br>");
    expect(html).toContain("있음<br>");
    expect(html).toContain("├── 현재 collab guest는");
    expect(html).toContain("└── 빠진 것은 guest → host 방향");
  });

  test("preserves soft line breaks inside tight list items", () => {
    const html = renderMarkdown("- Decision:\n  │   └── detail");

    expect(html).toContain("<li>Decision:<br>│   └── detail</li>");
  });

  test("continues escaping raw HTML", () => {
    const html = renderMarkdown("safe\n<img src=x onerror=alert(1)>");

    expect(html).toContain("safe<br>");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).not.toContain("<img src=x");
  });

  test("strips span and text HTML tags but preserves their contents and inline text rendering", () => {
    const html = renderMarkdown("<span></span><text>▃</text>");

    expect(html).toContain("▃");
    expect(html).not.toContain("&lt;span&gt;");
    expect(html).not.toContain("&lt;text&gt;");
  });

  test("unescapes HTML entities inside span and text HTML tags safely", () => {
    const html = renderMarkdown("<span>&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;</span>");

    expect(html).toContain("&lt;▃&gt; &amp; &quot;test&quot; &#128512; &#x1F600;");
  });

  test("strips advisory wrapper tags but renders their content", () => {
    const html = renderMarkdown(
      '<advisory severity="info" guidance="weigh, don&apos;t blindly obey">\nKeep this advice.\n</advisory>',
    );

    expect(html).toContain("Keep this advice.");
    expect(html).not.toContain("&lt;advisory");
    expect(html).not.toContain("&lt;/advisory&gt;");
  });

  test("typesets every delimiter form and marks display math", () => {
    const inline = renderMarkdown("energy $E=mc^2$ and \\(x^2\\) here");
    expect(inline).toContain('encoding="application/x-tex">E=mc^2</annotation>');
    expect(inline).toContain('encoding="application/x-tex">x^2</annotation>');
    expect(inline).not.toContain('display="block"');

    const display = renderMarkdown("$$E=mc^2$$ and \\[y^2\\]");
    expect(display.match(/display="block"/g)?.length).toBe(2);
  });

  test("emits CSP-compatible MathML rather than font-dependent KaTeX HTML", () => {
    const html = renderMarkdown("$E=mc^2$");

    expect(html).toContain("<math");
    expect(html).not.toContain("katex-html");
    expect(html).not.toContain("katex-strut");
    expect(html).not.toContain("style=");
    expect(html).not.toContain("url(");
  });

  test("does not trust URL-producing TeX commands", () => {
    const html = renderMarkdown(String.raw`$\href{https://example.com}{x}$`);

    expect(html).toContain("<math");
    expect(html).not.toContain("<a ");
    expect(html).not.toContain("<a>");
  });

  test("renders an own-line block as one display equation with its rows intact", () => {
    const html = renderMarkdown("$$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n$$");

    expect(html).toContain('display="block"');
    expect(html).toContain("\\begin{pmatrix}a &amp; b \\\\ c &amp; d\\end{pmatrix}");
  });

  test("leaves currency, escaped dollars, and code spans untouched", () => {
    const money = renderMarkdown("it costs $5 and $10 total, or \\$20 with tax");
    expect(money).not.toContain("katex");
    expect(money).toContain("it costs $5 and $10 total, or $20 with tax");

    const code = renderMarkdown("run `$PATH` and `$5$`");
    expect(code).not.toContain("katex");
    expect(code).toContain("<code>$PATH</code>");
  });

  test("keeps a dollar run that contains a code span as prose", () => {
    const html = renderMarkdown("$x `code` y$");

    expect(html).not.toContain("katex");
    expect(html).toContain("<code>code</code>");
  });

  test("matches the TUI by not typesetting a span behind a rejected dollar opener", () => {
    expect(renderMarkdown("it costs $5, and the growth is $x^2$ per year")).toBe(
      '<div class="tr-md"><p>it costs $5, and the growth is $x^2$ per year</p>\n</div>',
    );
    expect(renderMarkdown("it costs \\$5, and the growth is $x^2$ per year")).toContain(
      'encoding="application/x-tex">x^2</annotation>',
    );
  });

  test("typesets a span that follows a long run of ordinary prose", () => {
    const html = renderMarkdown(`${"lorem ipsum dolor sit amet ".repeat(400)}and finally $q^2$`);

    expect(html).toContain('encoding="application/x-tex">q^2</annotation>');
  });

  test("leaves half-streamed delimiters literal without reflowing the paragraph", () => {
    expect(renderMarkdown("streaming $x^2")).toBe('<div class="tr-md"><p>streaming $x^2</p>\n</div>');
    expect(renderMarkdown("streaming \\(x and \\[y")).toBe(
      '<div class="tr-md"><p>streaming (x and [y</p>\n</div>',
    );
    expect(renderMarkdown("before\n   $$\nunclosed")).toBe(
      '<div class="tr-md"><p>before<br>   $$<br>unclosed</p>\n</div>',
    );
  });

  test("keeps a half-streamed display opener whole instead of re-opening its second dollar", () => {
    expect(renderMarkdown("$$x$")).toBe('<div class="tr-md"><p>$$x$</p>\n</div>');
    expect(renderMarkdown("total $$x$ pending")).toBe('<div class="tr-md"><p>total $$x$ pending</p>\n</div>');
  });

  test("closes a span at the first unescaped delimiter", () => {
    const html = renderMarkdown(String.raw`\(a \\) b\) tail`);

    expect(html).toContain(String.raw`a \\) b`);
    expect(html).toContain("tail");
  });

  test("renders display math that is attached to the prose line above it", () => {
    const html = renderMarkdown("prose\n$$\n\\begin{pmatrix}a & b \\\\ c & d\\end{pmatrix}\n$$\ntail");

    expect(html).toContain('display="block"');
    expect(html).toContain("\\begin{pmatrix}a &amp; b \\\\ c &amp; d\\end{pmatrix}");
    expect(html).toContain("prose");
    expect(html).toContain("tail");
  });

  test("needs a blank line before a display block whose body contains one", () => {
    expect(renderMarkdown("prose\n\n$$\na\n\nb\n$$")).toContain('display="block"');
    expect(renderMarkdown("prose\n$$\na\n\nb\n$$")).not.toContain("<math");
  });

  test("keeps the rest of a message when one span is invalid TeX", () => {
    const html = renderMarkdown("$\\frac$ and **bold**");

    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("\\frac");
  });
});
