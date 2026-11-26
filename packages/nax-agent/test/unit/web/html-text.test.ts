import { describe, expect, test } from "bun:test";
import { htmlToText } from "#src/web/html-text";

const BASE = "https://a.example/base/";

/** One AC per row: the html and the page text it must reduce to. */
const DROPPED_CONTENT: readonly (readonly [ac: string, html: string])[] = [
  ["AC-4", "<p>x</p><script>evil()</script>"],
  ["AC-5", "<style>p{}</style><p>x</p>"],
  ["AC-10", "<nav>n</nav><p>x</p>"],
  ["AC-11", "<footer>f</footer><p>x</p>"],
  ["AC-12", "<noscript>n</noscript><p>x</p>"],
  ["AC-13", "<template>t</template><p>x</p>"],
  ["AC-14", "<svg><text>s</text></svg><p>x</p>"],
];

describe("htmlToText", () => {
  test("AC-1: reads the title out of the head", () => {
    expect(htmlToText("<html><head><title>T</title></head><body></body></html>", "https://a.example/").title).toBe("T");
  });

  test("AC-2: renders a heading as hash-prefixed text", () => {
    expect(htmlToText("<h2>Hi</h2>", BASE).text).toBe("## Hi");
  });

  test("AC-3: decodes an entity in the page text", () => {
    expect(htmlToText("<p>a&amp;b</p>", BASE).text).toBe("a&b");
  });

  test.each(DROPPED_CONTENT)("%s: drops the element's contents from the page text", (_ac, html) => {
    expect(htmlToText(html, BASE).text).toBe("x");
  });

  test("AC-6: renders a link as its text with the absolute URL beside it", () => {
    expect(htmlToText('<a href="/docs">Docs</a>', BASE).text).toBe("Docs (https://a.example/docs)");
  });

  test("AC-7: collects the absolute URL of a link", () => {
    expect(htmlToText('<a href="/docs">Docs</a>', BASE).links).toEqual(["https://a.example/docs"]);
  });

  test("AC-8: renders list items as dash-prefixed lines", () => {
    expect(htmlToText("<ul><li>one</li><li>two</li></ul>", BASE).text).toBe("- one\n- two");
  });

  test("AC-9: renders a pre block as a fence with its spacing intact", () => {
    expect(htmlToText("<pre>x  y</pre>", BASE).text).toBe("```\nx  y\n```");
  });

  test("AC-15: drops a comment", () => {
    expect(htmlToText("<!-- c --><p>x</p>", BASE).text).toBe("x");
  });

  test("AC-16: decodes decimal and hexadecimal numeric references", () => {
    expect(htmlToText("&#65;&#x42;", BASE).text).toBe("AB");
  });

  test("AC-17: decodes a non-breaking space to a space", () => {
    expect(htmlToText("a&nbsp;b", BASE).text).toBe("a b");
  });

  test("AC-18: collapses a run of spaces", () => {
    expect(htmlToText("<p>a    b</p>", BASE).text).toBe("a b");
  });

  test("AC-19: collapses a run of breaks to one blank line", () => {
    expect(htmlToText("<p>a</p><br><br><br><br><p>b</p>", BASE).text).toBe("a\n\nb");
  });
});

describe("htmlToText document shape", () => {
  test("omits the title when the document has none", () => {
    expect(htmlToText("<p>x</p>", BASE)).toEqual({ text: "x", links: [] });
  });

  test("omits an empty title rather than returning one", () => {
    expect(htmlToText("<title>  </title><p>x</p>", BASE).title).toBeUndefined();
  });

  test("separates consecutive paragraphs with one blank line", () => {
    expect(htmlToText("<p>a</p><p>b</p>", BASE).text).toBe("a\n\nb");
  });

  test("keeps the pre block on its own lines when text surrounds it", () => {
    expect(htmlToText("<p>a</p><pre>x  y</pre><p>b</p>", BASE).text).toBe("a\n\n```\nx  y\n```\n\nb");
  });
});

describe("htmlToText links", () => {
  test("resolves a relative href against the page URL", () => {
    expect(htmlToText('<a href="../guide">G</a>', BASE).links).toEqual(["https://a.example/guide"]);
  });

  test("normalises a collected URL the way the rest of the subsystem spells it", () => {
    expect(htmlToText('<a href="HTTPS://A.example:443/x#frag">X</a>', BASE).links).toEqual(["https://a.example/x"]);
  });

  test("records each URL once, in first-seen order", () => {
    expect(htmlToText('<a href="/a">a</a><a href="/a">a</a><a href="/b">b</a>', BASE).links).toEqual([
      "https://a.example/a",
      "https://a.example/b",
    ]);
  });

  test("renders link text alone for an in-page anchor, recording nothing", () => {
    const page = htmlToText('<a href="#top">Top</a>', BASE);
    expect(page.text).toBe("Top");
    expect(page.links).toEqual([]);
  });

  test("renders link text alone for a non-http scheme, recording nothing", () => {
    const page = htmlToText('<a href="mailto:a@b.example">Mail</a>', BASE);
    expect(page.text).toBe("Mail");
    expect(page.links).toEqual([]);
  });

  test("renders a link with no text as its URL", () => {
    expect(htmlToText('<a href="/docs"> </a>', BASE).text).toBe("https://a.example/docs");
  });

  test("decodes an entity in the href before resolving it", () => {
    expect(htmlToText('<a href="/x?a=1&amp;b=2">Q</a>', BASE).links).toEqual(["https://a.example/x?a=1&b=2"]);
  });

  test("records nothing for an anchor with no href", () => {
    expect(htmlToText("<a name=x>N</a>", BASE)).toEqual({ text: "N", links: [] });
  });
});

describe("htmlToText text shaping", () => {
  test("renders h1 through h6 at their own level", () => {
    expect(htmlToText("<h1>a</h1><h3>b</h3>", BASE).text).toBe("# a\n\n### b");
  });

  test("turns a table row into a line break", () => {
    expect(htmlToText("<table><tr><td>a</td></tr><tr><td>b</td></tr></table>", BASE).text).toBe("a\n\nb");
  });

  test("decodes quote and apostrophe references", () => {
    expect(htmlToText("<p>&quot;a&quot; &#39;b&#39;</p>", BASE).text).toBe("\"a\" 'b'");
  });

  test("leaves an entity it does not know as written", () => {
    expect(htmlToText("<p>a&hellip;b</p>", BASE).text).toBe("a&hellip;b");
  });

  test("does not decode a decoded entity a second time", () => {
    expect(htmlToText("<p>&amp;lt;</p>", BASE).text).toBe("&lt;");
  });

  test("collapses a title's own whitespace and entities", () => {
    expect(htmlToText("<title>  a\n  &amp;  b </title>", "https://a.example/").title).toBe("a & b");
  });

  test("ignores a stray angle bracket that is not a tag", () => {
    expect(htmlToText("<p>a < b</p>", BASE).text).toBe("a < b");
  });

  test("keeps a greater-than inside an attribute from ending the tag", () => {
    expect(htmlToText('<a title="a>b" href="/x">X</a>', BASE).links).toEqual(["https://a.example/x"]);
  });

  test("returns empty text for a page with no text", () => {
    expect(htmlToText("<html><body><script>x</script></body></html>", BASE).text).toBe("");
  });

  test("keeps the text of a tag the page never closes", () => {
    expect(htmlToText("a <b", BASE).text).toBe("a <b");
  });

  test("drops a nested element whole, not only up to its first closing tag", () => {
    expect(htmlToText("<template><template>t</template>leak</template><p>x</p>", BASE).text).toBe("x");
  });

  test("drops the contents of an element the page never closes", () => {
    expect(htmlToText("<p>x</p><script>evil()", BASE).text).toBe("x");
  });

  test("drops a hidden element's link when the element is never closed", () => {
    const page = htmlToText('<p>visible</p><script>const secret = 1; <a href="https://hidden.example/">h</a>', BASE);
    expect(page.text).toBe("visible");
    expect(page.links).toEqual([]);
  });

  test("drops an unclosed style or template to the end of the page", () => {
    expect(htmlToText("<p>x</p><style>p{color:red}", BASE).text).toBe("x");
    expect(htmlToText("<p>x</p><template><b>t</b>", BASE).text).toBe("x");
  });

  test("ends a script where its own closing tag is, not at a tag written inside it", () => {
    expect(htmlToText('<script>var a = "<script>";</script><p>x</p>', BASE).text).toBe("x");
  });

  test("drops a raw-text element whose attribute carries a quoted tag-shaped value", () => {
    const page = htmlToText(
      '<script data-note="> </script>">const secret = 1; <a href="https://hidden.example/">h</a></script><p>x</p>',
      BASE,
    );
    expect(page.text).toBe("x");
    expect(page.links).toEqual([]);
  });

  test("does not let tag-shaped CSS hide a subsequent script opening", () => {
    const page = htmlToText(
      '<style>/* <div data-x=" */</style><script>// " <a href=https://hidden.example/>hidden</a></script><p>visible</p>',
      BASE,
    );
    expect(page).toEqual({ text: "visible", links: [] });
  });

  test.each([
    ["style", "script"],
    ["script", "style"],
  ])("ignores a fake %s body tag naming %s", (outer, inner) => {
    const page = htmlToText(`<${outer}>"<${inner}>"</${outer}><p>visible</p>`, BASE);
    expect(page).toEqual({ text: "visible", links: [] });
  });

  test("ends a style where a quoted tag-shaped attribute value does not", () => {
    const page = htmlToText('<style data-note="> </style>">p{}</style><p>x</p>', BASE);
    expect(page.text).toBe("x");
  });

  test("keeps a custom element whose name only starts with a raw-text element's", () => {
    expect(htmlToText("<script-demo>shown</script-demo> <style-demo>too</style-demo>", BASE).text).toBe("shown too");
  });

  test("does not read a raw-text opening tag out of another tag's attribute", () => {
    expect(htmlToText('<div data-x="<script>">t</div>', BASE).text).toBe("t");
  });

  test("keeps a closing tag whose name only starts with a raw-text element's", () => {
    expect(htmlToText("<script>a</scriptx>b</script><p>x</p>", BASE).text).toBe("x");
  });

  test("treats a closing tag the page never terminates as an element left open", () => {
    expect(htmlToText("<p>x</p><script>evil()</script", BASE).text).toBe("x");
  });

  test("ignores a doctype", () => {
    expect(htmlToText("<!DOCTYPE html><p>x</p>", BASE).text).toBe("x");
  });

  test("ignores a closing tag that opens nothing", () => {
    expect(htmlToText("</a><p>x</p>", BASE)).toEqual({ text: "x", links: [] });
  });

  test("keeps a character reference to a character it will not decode as written", () => {
    expect(htmlToText("<p>&#0;</p>", BASE).text).toBe("&#0;");
  });

  test("renders link text alone when the page URL does not parse", () => {
    const page = htmlToText('<a href="/x">X</a>', "not a url");
    expect(page.text).toBe("X");
    expect(page.links).toEqual([]);
  });
});
