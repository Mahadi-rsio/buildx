# BuildX Design System — Lean, Premium, Monochrome

## Overview
BuildX uses a strictly monochrome design system inspired by Vercel, Linear, and Geist. The aesthetic is quiet, featuring ample whitespace, precise typography, and hierarchy derived entirely from typography and opacity rather than color or decorative borders.

## Design Tokens (Single Source of Truth)
Defined in `app/globals.css` as CSS variables and mapped via Tailwind:

### Colors (Dark Theme)
- `--bg` (`#0A0A0A`): Background layer
- `--surface` (`#111111`): Surfaces for code blocks, composer, popovers
- `--surface-hover` (`#161616`): Interactive hover state
- `--border` (`#1F1F1F`): Hairline border, used sparingly
- `--text` (`#EDEDED`): Primary text
- `--text-muted` (`#A1A1A1`): Secondary text, labels, verbs
- `--text-faint` (`#6B6B6B`): Tertiary text, paths, timestamps
- `--accent` (`#FFFFFF`): Primary actions / active indicators (inverted white-on-black)

### Typography
- **UI Font**: Geist Sans
- **Code / Paths / Commands**: Geist Mono
- **Weights**: 400 (regular) and 500 (medium) only.

---

## ToolCallRow Component & Variants
`ToolCallRow` is the unified shared component for rendering all agent tool calls.

### Layout
`[Icon 14px] [Verb in --text-muted] [Target in Geist Mono --text] ........ [Status / Chevron]`
- **Height**: 32px desktop, 36px mobile.
- **Hover**: `--surface-hover` with 6px radius.
- **Paths**: Basename prominently displayed with directory in `--text-faint` before it. Truncated from the left (`…/src/App.vue`), never cutting the filename.

### States
1. **Default (Succeeded)**: Quiet, muted verb, bright target, no heavy icon.
2. **Hover**: `--surface-hover` background with 6px radius.
3. **Running**: Subtle shimmer or pulse on the verb/spinner; auto-expanded or in-flight animation.
4. **Failed**: `X` icon + label turns full white with "Failed" suffix — zero red color.
5. **Expanded**: Indented 22px, aligned with the label, flat content block without an extra border box.
6. **Disabled**: Interactive elements disabled during run execution.

---

## Do / Don't Guidelines

### DO
- **Strictly monochrome**: Use only shades of black, white, and gray (`#0A0A0A`, `#111111`, `#1F1F1F`, `#6B6B6B`, `#A1A1A1`, `#EDEDED`, `#FFFFFF`).
- **Flat rows**: Keep tool rows flat by default with no nested cards or colored borders.
- **Opacity hierarchy**: Use text opacity (`--text`, `--text-muted`, `--text-faint`) to create visual hierarchy.
- **Monochrome status**: Communicate status via icon shape (spinner, X, check) and opacity, never via red/green/yellow/blue status badges.

### DON'T
- **No nested cards**: Never wrap a bordered container inside another bordered container.
- **No grouping**: Every tool call is its own row in chronological order. No "Ran N commands" group summary cards.
- **No colored status**: No green success dots, red error borders, or blue/yellow warning badges.
- **No decorative colors**: No gradients, glows, or shadows except a subtle single shadow on floating dropdown layers.
