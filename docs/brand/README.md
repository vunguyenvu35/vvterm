<p align="center"><img src="logo-mark-256.png" alt="VVTerm" width="88"></p>

# VVTerm brand

Concept: the letter **W** is two **V**s (VV). Its five vertices are network nodes, the centre one is the "AI core", and the cyan bar is a terminal cursor. Digital, calm, and secure rather than neon-noisy.

| File | Use |
| --- | --- |
| `logo-mark.svg` / `logo-mark-1024.png` | App tile, avatars, social preview |
| `logo-horizontal.svg` / `.png` | Dark backgrounds (README dark mode, slides) |
| `logo-horizontal-light.svg` / `.png` | Light backgrounds (README, docs) |
| `favicon.svg` / `favicon-64.png` | Simplified mark for small sizes (no circuit traces) |
| `social-preview.svg` / `.png` | 1280x640 GitHub social preview: upload in *Settings → General → Social preview* (cannot be set from a file) |
| `../../build/windows/icon.ico` | Windows icon (16–256 px, small sizes use the simplified mark) |
| `../../build/appicon.png` | macOS app icon (1024 px with 100 px safe margin); Wails derives the `.icns` from it |

Regenerate the PNGs with `node docs/brand/render.mjs '<jobs json>'` (needs the Playwright install from `e2e/`; see the file header). The About box of the macOS app embeds `build/appicon.png`. The SVG wordmark uses a monospace font stack (JetBrains Mono, SF Mono, Menlo…); use the PNGs where the exact look matters.

## Palette

| Token | Hex | Use |
| --- | --- | --- |
| Ink | `#0B1020` | tile background, text on light |
| Night | `#070A18` | gradient end |
| Indigo | `#5B8CFF` | gradient start, accent |
| Cyan | `#22D3EE` | cursor, core highlight |
| Violet | `#A78BFA` | gradient end |
| Mist | `#F2F5FF` | text on dark |

## Rules

- Keep clear space of at least the height of the centre node around the mark.
- Minimum size: 24 px for the mark (use `favicon.svg` below 48 px).
- Do not recolour the gradient, rotate, add outlines, or place the dark tile on a dark background without the light/dark lockup that fits.
