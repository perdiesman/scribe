---
title: SCRIBE sample
---

# SCRIBE

**Write what you see. Commit what you mean.**

Synchronized Content Rendering & Interactive Block Editing.

## Edit visually

Try **bold**, *italic*, ~~strikethrough~~, `inline code`, and a [reference link][scribe].

- [ ] Try the Auto Markdown toggle
- [ ] Open source beside the visual editor
- [x] Keep untouched Markdown intact

1. Write a document.
2. Review the source.
3. Export HTML or PDF.

> [!TIP]
> Turn Auto Markdown off when you want to type literal Markdown characters.

| Feature | Ready to try |
| --- | --- |
| Visual editing | Yes |
| Code copying | Yes |
| Exports | Yes |

## Code

```typescript
const message = 'Write what you see.';
console.log(message);
```

## Diagram

```mermaid
flowchart LR
  Write --> See
  See --> Review
  Review --> Commit
```

## Math

Inline math: $E = mc^2$.

$$
\int_0^1 x^2\,dx = \frac{1}{3}
$$

## Details and notes

<details>
<summary>More about SCRIBE</summary>

The Markdown file remains the source of truth.

</details>

A note worth preserving.[^note]

[^note]: This footnote is included in exported documents.

<!-- This comment should survive visual edits. -->

[scribe]: https://github.com/perdiesman/scribe "SCRIBE"
