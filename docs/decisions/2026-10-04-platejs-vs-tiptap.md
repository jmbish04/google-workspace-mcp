# Use Tiptap as the single rich-text editor stack

- **Date:** 2026-10-04
- **Status:** accepted

## Context

The application currently uses PlateJS 53 and five `@platejs/*` packages for
`/notes` and the Gmail draft studio. The five selected ReUI rich-text editor
blocks use Tiptap. Keeping both frameworks would duplicate editor schemas,
serialization, extensions, browser-only integration, accessibility behavior,
and dependency maintenance for the same product surface.

## Decision

Tiptap becomes the only rich-text editor stack in the application. The ReUI
blocks are the implementation foundation and must be used as shipped; shared
features such as toolbars, bubble menus, slash commands, suggestions, comments,
collaboration, and presence are not reimplemented locally.

PlateJS and the five `@platejs/*` packages will be removed after their two
consumers have migrated. The migration may be delivered incrementally, but the
temporary overlap is migration work, not a supported two-stack architecture.

Every Astro island that uses Tiptap or Yjs must mount with
`client:only="react"`. These libraries are browser-only and must not run during
Astro server rendering.

## Serialization and email boundary

`shared/plate-html.ts` will be replaced by a framework-neutral Tiptap adapter
using `generateHTML` and `generateJSON` from `@tiptap/html`, configured with the
same extension set as the editor. Callers will migrate to the new adapter, tests
will cover HTML-to-JSON and JSON-to-HTML compatibility, and the Plate-specific
module will then be deleted.

The editor remains an input surface. Gmail output continues through
`backend/gmail/compose.ts`; Tiptap or ReUI HTML is never sent directly. The
existing Gmail HTML standard remains authoritative for sanitization, layout,
inline styling, plaintext generation, reference markers, and authorship tags.

## `/notes` migration

`/notes` will move to a Tiptap-based React island mounted with
`client:only="react"`. Existing versioned Plate documents will be read through a
one-way migration path and saved in a versioned Tiptap JSON envelope. Legacy
plain-text fallback remains available until stored notes have been migrated.
Round-trip and legacy-fixture tests must fail if that compatibility path is
removed.

## Consequences

- The draft studio and `/notes` share one extension and serialization model.
- ReUI editor updates remain installable from the registry instead of being
  duplicated in local editor infrastructure.
- PlateJS removal is complete only after both consumers, persisted-content
  compatibility, and their tests have migrated.
- Agent-authored document changes default to tracked suggestions with an
  accept/reject step rather than direct document replacement.
