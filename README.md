# markdown-render-speed-02

[![make.fun · markdown-render-speed-02](https://make.fun/badge/markdown-render-speed-02.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![rank](https://make.fun/badge/markdown-render-speed-02/gmlokie/markdown-render-speed-02/rank.svg)](https://make.fun/bounty/markdown-render-speed-02/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)
[![reward](https://make.fun/badge/markdown-render-speed-02/gmlokie/markdown-render-speed-02/reward.svg)](https://make.fun/bounty/markdown-render-speed-02?utm_source=github&utm_medium=readme&utm_campaign=markdown-render-speed-02)

A dependency-free, drop-in replacement for `marked` 18.1.3 (default options,
GFM on) that renders Markdown to HTML byte-for-byte identically — but faster.

## How it works

`parse.js` is a fused single-pass recursive-descent renderer: it walks the
block and inline structure once and renders directly to a string with `+=`,
with no token tree and no separate lex → parse phase. Block and inline
dispatch are per-character (switch), and escaping / entity decoding use
regexes. The result is identical HTML to `marked.parse` for every input,
verified against all 720 practice cases (680 CommonMark 0.31.2 + GFM spec
examples and 40 generated documents).

## Layout

- `parse.js` — the renderer. `parse(markdown)` returns the HTML string.
- `main.ts` — the harness driver: reads `/input/cases.json`, renders each
  case with `parse`, writes `/output/html.json`. The output is staged to a
  per-run temp file and atomically renamed into place, so two concurrent
  runs into the same `/output` can never corrupt each other.
- `package.json` — `{"type": "module"}` (ES modules, no dependencies).

## License

MIT — see `LICENSE`.
