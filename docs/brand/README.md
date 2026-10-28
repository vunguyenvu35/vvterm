<p align="center"><img src="logo-mark-256.png" alt="VVTerm" width="88"></p>

# VVTerm brand

Concept: the two **V**s of VVTerm, turned on their side, become a shell prompt `»`, followed by a block cursor `_`. Flat, two colours plus white, no glow or decoration: it reads the same at 1024 px and at 16 px.

| File | Use |
| --- | --- |
| `logo-mark.svg` / `logo-mark-1024.png` | App tile, avatars, social preview |
| `logo-horizontal.svg` / `.png` | Dark backgrounds (README dark mode, slides) |
| `logo-horizontal-light.svg` / `.png` | Light backgrounds (README, docs) |
| `favicon.svg` / `favicon-64.png` | Mark tuned for small sizes (thicker strokes) |
| `social-preview.svg` / `.png` | 1280x640 GitHub social preview: upload in *Settings → General → Social preview* (cannot be set from a file) |
| `../../build/windows/icon.ico` | Windows icon (16–256 px, small sizes use the simplified mark) |
| `../../build/appicon.png` | macOS app icon (1024 px with 100 px safe margin); Wails derives the `.icns` from it |

Regenerate the PNGs with `node docs/brand/render.mjs '<jobs json>'` (needs the Playwright install from `e2e/`; see the file header). The About box of the macOS app embeds `build/appicon.png`. The SVG wordmark uses a monospace font stack (JetBrains Mono, SF Mono, Menlo…); use the PNGs where the exact look matters.

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#0B1020` | tile background (bottom), text on light |
| Ink-2 | `#131B3A` | tile background (top, subtle vertical gradient) |
| Indigo | `#5B8CFF` | first chevron, "VV" in the wordmark |
| Cyan | `#22D3EE` | second chevron, accent |
| Mist | `#F2F5FF` | cursor, text on dark |

## Rules

- Keep clear space of at least the cursor width around the mark.
- Minimum size: 24 px for the mark (use `favicon.svg` below 48 px).
- Do not swap the chevron colours, add glow/gradients to the strokes, rotate, add outlines, or place the dark tile on a dark background without the light/dark lockup that fits.
