# Changelog

## 0.1.5

- Add a live left-side table of contents with heading navigation in all four views.
- Show the TOC automatically in wide editors, with a toolbar toggle that remembers a manual choice.

## 0.1.4

- Recognize inline and block math in source highlighting so LaTeX subscripts cannot start runaway Markdown emphasis.
- Restore the source-highlighting background while retaining correct text colors and alignment.

## 0.1.3 — Unreleased

- Prevent VS Code's default inline-code backgrounds, padding, and text color from leaking into Source and Split syntax highlighting.
- Add a rendered Read-only Preview mode with editing controls disabled, while keeping all view switches, rendering profiles, copying, and exports available.

## 0.1.2 — Unreleased

- Share a header row between branding and the toolbar when space permits, wrapping on narrower windows.
- Highlight Markdown syntax in Source and Split views while preserving editing, selection, and scrolling.

## 0.1.1 — Unreleased

- Compact icon toolbar with tooltips, themed dropdowns, a combined table menu, and corrected logo loading.
- Source and split modes inside one SCRIBE tab, with formatting controls and keyboard shortcuts in both panes.
- Preserve heading styles on Enter; leave code blocks with Down Arrow, Ctrl/Cmd+Enter, the exit button, or the blank line below.
- Show actual saved/unsaved document state.
- Finish export progress before displaying completion notifications and isolate the PDF browser callback from extension-host variables.
- Render Mermaid diagrams after mounting, follow the editor theme, and show source plus an error if rendering fails.

## 0.1.0 — Initial development build

- Initial SCRIBE custom Markdown editor with visual/source toggle and split views.
- Source preservation and explicit, undoable document normalization.
- Markdown typing shortcuts, Enter conversion, and persistent Auto Markdown toolbar toggle.
- GitHub/GitLab rendering profiles, GFM tables/tasks, math, Mermaid, alerts, footnotes, and sanitized HTML.
- Code-copy buttons/context actions and HTML/PDF export.
- Project logo, test suites, development launch configuration, and CI workflow.

Release pending full build, editor/extension tests, packaging, and platform validation.
