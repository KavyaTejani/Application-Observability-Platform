# UI Theme Specification — Neo-Brutalist (Light and Dark)

This is the single source of truth for the web app's visual design. Every value an
implementation needs is listed here. If a component looks different from this document, the
document wins (or the document is updated first).

| | |
|---|---|
| **Style** | Neo-brutalism: thick ink borders, hard offset shadows, flat colour, heavy type |
| **Phase 1** | Light mode (§1–§13). |
| **Phase 2** | Dark mode, same style ([§14](#14-phase-2-dark-neo-brutalist)): identical type, borders, and radii on a black canvas; cream edges, a deep violet accent, and deeper light-violet hard shadows. |
| **Applies to** | `apps/web` only. No API change. |
| **Token file** | `apps/web/src/index.css`: `:root` (light + shared shape/motion) and `[data-theme='dark']` (dark colours) |

---

## 1. Design principles

1. **Bold frame, calm data.** Brutalist styling (borders, shadows, colour) goes on the *frame*:
   navigation, cards, buttons, inputs, and headers. *Data* (chart plots, tables, log lines,
   numbers) stays on plain white with quiet ink, so values are easy to read.
2. **Status colours are reserved.** Green, amber, orange, and red mean *state* (normal, pending,
   error, firing) and nothing else. The decorative palette deliberately avoids those hues.
   A state is always shown with an **icon + text label**, never colour alone.
3. **Everything is an object.** Interactive surfaces have a 2 px ink border and a hard shadow, so
   they read as physical, clickable things. Pressing a button visibly pushes it down.
4. **One accent does the work.** Lavender marks the primary action and the current location.
   Pink and sky are rare highlights, never on data.
5. **Accessible by construction.** Every text/background pair below is measured (WCAG 2.2:
   ≥ 4.5:1 for text, ≥ 3:1 for UI boundaries and focus). No pair may be used outside the table.
6. **Motion is optional.** All movement is removed under `prefers-reduced-motion`.

---

## 2. Colour tokens

Semantic names are what components use. The Tailwind utility is shown in brackets
(`bg-surface`, `text-fg-muted`, …). Hex values are for `[data-theme='light']`.

### 2.1 Surfaces and ink

| Token | Hex | Use |
|---|---|---|
| `--c-canvas` | `#fbf7ef` | Page background (warm cream) |
| `--c-surface` | `#ffffff` | Cards, inputs, tables, top bar, chart plots |
| `--c-subtle` | `#f2ede2` | Table header row, hover fill, read-only fields, code blocks inside light cards |
| `--c-ink` | `#111111` | **All borders and hard shadows**, primary text |
| `--c-line` | `#111111` | Outer borders (same as ink) |
| `--c-divider` | `#d9d3c7` | Thin row dividers *inside* tables and lists only (decorative, not a boundary) |
| `--c-fg` | `#111111` | Primary text, headings, values |
| `--c-fg-secondary` | `#3a3a3a` | Body copy, descriptions |
| `--c-fg-muted` | `#5b5b5b` | Captions, hints, axis labels, timestamps |

### 2.2 Accent palette (decorative, never a state)

| Token | Hex | Use |
|---|---|---|
| `--c-accent` | `#b4a5ff` (lavender) | Primary button fill, active nav item, selected segment, checked chip |
| `--c-accent-hover` | `#a594ff` | Primary button hover fill |
| `--c-accent-fg` | `#111111` | Text/icons on lavender (ink, not white) |
| `--c-accent-soft` | `#e9e4ff` | Selected row, icon tiles, role badge "Owner" |
| `--c-accent-text` | `#4527c9` | Links and accent-coloured text on white/cream |
| `--c-pink` | `#ff90e8` | Brand mark, one-time-secret highlight edge, sign-in hero only |
| `--c-sky` | `#a5dcff` | Info banners, "receiving data" freshness tile accent |

Lavender, pink, and sky are chosen because they sit **outside** the status hues (green, amber,
orange, red), so a decorative surface can never be mistaken for a state.

### 2.3 Status colours (reserved, fixed)

Shared with the charts' status palette and identical in both themes.

| Role | Fill | Text on fill | Icon | Used for |
|---|---|---|---|---|
| good | `#0ca30c` | `#111111` (5.63:1) | CheckCircle2 | Rule Normal, Incident Resolved, Delivered, Receiving |
| warning | `#fab219` | `#111111` (10.29:1) | Clock | Rule Pending, key Expiring, quota ≥ 80 % |
| serious | `#ec835a` | `#111111` (7.16:1) | AlertOctagon | Rule Error, delivery Blocked |
| critical | `#d03b3b` | `#ffffff` (4.80:1) | TriangleAlert | Rule/Incident Firing, delivery Failed, quota reached |
| neutral | `#ffffff` | `#111111` | PauseCircle / CircleDot | Disabled, Idle, No data yet |

> Change from the current theme: the **good** badge text becomes ink (`#111111`). White on
> `#0ca30c` is only 3.35:1, which fails WCAG for small text.

### 2.4 Feedback banners (Alert component)

| Tone | Fill | Text | Border | Icon |
|---|---|---|---|---|
| error | `#ffe4e1` | `#b42318` (5.46:1) | 2 px ink | XCircle |
| warning | `#fff3d6` | `#8a4b00` (6.17:1) | 2 px ink | AlertTriangle |
| success | `#dcf7e7` | `#05603a` (6.75:1) | 2 px ink | CheckCircle2 |
| info | `#a5dcff` (sky) | `#111111` (12.84:1) | 2 px ink | Info |

Banners have a border but **no shadow** (they are messages, not objects you press).

---

## 3. Contrast table (measured)

Only these pairs may be used. Ratios computed with the WCAG 2.2 relative-luminance formula.

| Foreground | Background | Ratio | Requirement | Result |
|---|---|---|---|---|
| ink `#111111` | canvas `#fbf7ef` | 17.67 | 4.5 | ✅ |
| ink | white | 18.88 | 4.5 | ✅ |
| ink | subtle `#f2ede2` | 16.17 | 4.5 | ✅ |
| fg-secondary `#3a3a3a` | canvas | 10.64 | 4.5 | ✅ |
| fg-muted `#5b5b5b` | canvas | 6.36 | 4.5 | ✅ |
| fg-muted | white | 6.79 | 4.5 | ✅ |
| fg-muted | subtle | 5.82 | 4.5 | ✅ |
| ink | lavender `#b4a5ff` | 8.78 | 4.5 | ✅ |
| ink | lavender-soft `#e9e4ff` | 15.29 | 4.5 | ✅ |
| link `#4527c9` | white | 8.80 | 4.5 | ✅ |
| link | canvas | 8.23 | 4.5 | ✅ |
| ink | pink `#ff90e8` | 9.36 | 4.5 | ✅ |
| ink | sky `#a5dcff` | 12.84 | 4.5 | ✅ |
| status text on fills | see §2.3 | ≥ 4.80 | 4.5 | ✅ |
| banner text on fills | see §2.4 | ≥ 5.46 | 4.5 | ✅ |
| border ink | canvas | 17.67 | 3 (UI boundary) | ✅ |
| focus ring `#4527c9` | canvas | 8.23 | 3 | ✅ |
| lavender fill | canvas | 2.01 | — | Not a boundary: the 2 px ink border provides the 17.67:1 edge |
| divider `#d9d3c7` | white | 1.49 | — | Decorative only; never the sole separator of interactive items |

---

## 4. Typography

| Role | Font | Weight | Size / line height | Extras |
|---|---|---|---|---|
| Display: page titles (h1) | **Space Grotesk** (variable, self-hosted) | 700 | 30 px / 36 px | tracking −0.02 em |
| Card titles (h2) | Space Grotesk | 700 | 16 px / 24 px | — |
| Section labels (sidebar groups, table headers) | Space Grotesk | 700 | 11 px / 16 px | UPPERCASE, tracking +0.08 em |
| Buttons, tabs, nav items | Space Grotesk | 600 | 14 px (sm: 12 px) | — |
| Big numbers (stat tiles, KPI values) | Space Grotesk | 700 | 28 px / 32 px | `tabular-nums` |
| Body, descriptions, form labels | **Inter** (variable, self-hosted; already installed) | 400 / 500 | 14 px / 20 px | — |
| Captions, hints | Inter | 400 | 12 px / 16 px | fg-muted |
| Code, keys, log lines, timestamps | **JetBrains Mono** (self-hosted) | 400 | 12–13 px | — |

- Fonts are bundled through `@fontsource-variable/*` packages and served from our own origin, so
  the strict Content-Security-Policy (`font-src 'self'`) needs no change.
- Numbers in tables and tiles always use `tabular-nums` so columns align.

---

## 5. Shape: borders, radius, shadows

| Token | Value | Use |
|---|---|---|
| `--border-w` | `2px` | All outer borders (cards, buttons, inputs, badges, nav items, chips) |
| `--radius-sm` | `4px` | Badges, chips, checkboxes |
| `--radius` | `8px` | Buttons, inputs, nav items, banners |
| `--radius-lg` | `10px` | Cards, chart frames, stat tiles |
| `--radius-full` | `9999px` | Avatar, status badges, pills |
| `--shadow-sm` | `2px 2px 0 0 var(--c-ink)` | Small buttons, nav item (active), chips (checked) |
| `--shadow` | `3px 3px 0 0 var(--c-ink)` | Buttons, inputs (focus only), switchers |
| `--shadow-lg` | `5px 5px 0 0 var(--c-ink)` | Cards, stat tiles, chart frames, project cards |
| `--shadow-hover` | `5px 5px 0 0 var(--c-ink)` | Clickable cards on hover |

Rules:

- Shadows are **hard** (zero blur) and always toward the bottom-right, in ink.
- No gradients, no blur, no glass effects anywhere.
- Things you click have a shadow; things you only read (banners, tables inside cards, badges)
  do not.
- Inside a card, sections are separated with a **2 px ink** rule under the header and **1 px
  divider** (`#d9d3c7`) between rows.

---

## 6. Interaction states

| State | Buttons | Clickable cards / list rows | Inputs |
|---|---|---|---|
| Rest | border + `--shadow` | border + `--shadow-lg` | border, no shadow |
| Hover | fill → hover colour; translate(−1px, −1px), shadow +1px | translate(−2px, −2px), `--shadow-hover`, subtle fill on rows | border stays ink |
| Active (pressed) | translate(3px, 3px), shadow 0 (button "presses in") | translate(2px, 2px), shadow `--shadow-sm` | — |
| Focus-visible | 3 px outline `#4527c9`, offset 2 px | same | `--shadow` in lavender-ink (`3px 3px 0 #4527c9`), no outline |
| Disabled | 50 % opacity, no shadow, no transform, `not-allowed` cursor | — | subtle fill, fg-muted text |
| Loading | label changes to "…ing"; button disabled | — | — |

- Transition: `transform 80ms ease-out, box-shadow 80ms ease-out, background-color 80ms`.
- `@media (prefers-reduced-motion: reduce)`: no transforms or transitions; only colour changes.

---

## 7. Components

### 7.1 Button (`components/ui.tsx`)

| Variant | Fill | Text | Border | Shadow | Use |
|---|---|---|---|---|---|
| primary | lavender `#b4a5ff` | ink | 2 px ink | `--shadow` | The main action of a view (one per area) |
| secondary | white | ink | 2 px ink | `--shadow` | Other actions (Edit, Rotate, Refresh, Send test) |
| danger | `#d03b3b` | white | 2 px ink | `--shadow` | **Confirm** destructive actions only (Confirm delete, Yes, delete…) |
| danger-outline | white | `#b42318` | 2 px ink | `--shadow` | The first step of a destructive action (Delete project) |
| ghost | transparent | fg-secondary | none | none | Low-priority actions (Cancel, Clear, inline Delete) |

Sizes: md = 36 px high, 14 px text, 14 px horizontal padding; sm = 30 px, 12 px text, 10 px
padding. Icon 16 px (sm: 14 px) left of the label, 8 px gap.

### 7.2 Text field and select

- 2 px ink border, white fill, radius 8 px, 40 px high, 12 px horizontal padding.
- Label above: Inter 500, 14 px, ink, 6 px gap.
- Hint below: 12 px fg-muted. Error below: 12 px `#b42318` with the field border turning
  `#b42318`.
- Focus: border stays ink, `3px 3px 0 #4527c9` shadow.
- Select uses the same box plus a chevron icon (ink).

### 7.3 Card

- White, 2 px ink border, radius 10 px, `--shadow-lg`.
- Header: 16 px/700 Space Grotesk title, optional description (14 px fg-secondary), optional
  actions on the right; 2 px ink rule under the header; padding 20 px.
- Body padding 20 px (or 0 for edge-to-edge tables).

### 7.4 Stat tile (KPI)

- Card styling (border + `--shadow-lg`) on white.
- Label: 11 px uppercase Space Grotesk, fg-muted, with a 14 px icon.
- Value: 28 px/700 Space Grotesk, ink, `tabular-nums`.
- Hint: 12 px fg-muted.
- **No coloured backgrounds** on tiles: numbers stay on white.

### 7.5 Badges

- Status badges (§2.3): pill, 1.5 px ink border, 12 px/600 Inter, icon 14 px + label.
- Neutral pill (environment, "Idle"): white fill, 1.5 px ink border, ink text.
- Role badge: Owner = lavender-soft fill; Member = white. Both bordered.

### 7.6 Tables

- Inside a card, edge to edge.
- Header row: subtle fill `#f2ede2`, 11 px uppercase Space Grotesk 700, fg-muted, 2 px ink rule
  below.
- Rows: 14 px Inter, 12 px vertical padding, 1 px divider `#d9d3c7` between rows, hover fill
  subtle.
- Numbers right-aligned, `tabular-nums`.

### 7.7 Banners (Alert)

As §2.4: tinted fill, 2 px ink border, radius 8 px, 16 px icon, no shadow.

### 7.8 Empty state

- 48 px lavender-soft square tile with 2 px ink border and `--shadow-sm`, 22 px ink icon.
- Title 14 px/700 Space Grotesk, text 14 px fg-secondary, optional button below.

### 7.9 Code and secrets

- Code blocks (SDK setup): ink `#111111` fill, `#f2ede2` text, JetBrains Mono 12 px, radius 8
  px, 2 px ink border, no shadow.
- One-time secret box (new API key / signing secret): warning-soft fill `#fff3d6`, 2 px ink
  border, `--shadow`, the secret in a white mono field; the box has a 6 px **pink** left edge so it
  is unmistakably "act now" without using a status colour.

### 7.10 Charts (`TimeSeriesChart.tsx`)

The chart **frame** follows the card spec; the **plot** stays quiet:

- Plot background white; no border, shadow, or fill inside the plot area.
- Gridlines `#ece7dc` 1 px horizontal only; axis line `#c9c2b4`; tick labels 11 px fg-muted.
- Series colours unchanged from the validated light palette (`#2a78d6`, `#eb6834`, `#1baf7a`),
  2 px lines, no area fill. They were validated against white, which stays the plot surface.
- Legend for ≥ 2 series; "Show data table" link in `#4527c9`.
- Tooltip: white, 2 px ink border, `--shadow-sm`, radius 6 px, 12 px text.
- "No data in this time range" overlay: fg-muted text on the white plot.

### 7.11 Log explorer

- Log rows on white, JetBrains Mono timestamps, severity badges as status pills (TRACE/DEBUG/
  INFO neutral; WARN warning; ERROR critical; FATAL `#8f1f1f` with white text, 8.81:1).
- Expanded detail: subtle fill, 1 px divider; no shadows inside the list.
- Severity filter chips: white with 2 px ink border; checked = lavender fill + `--shadow-sm`.

### 7.12 Text selection

Interface chrome is not text-selectable; content always is. Copying is never blocked: this is a
developer tool, and keys, IDs, commands, and log text must be copyable (blocking copy would also
protect nothing and would hurt accessibility).

| Rule | Elements |
|---|---|
| `select-none` | Buttons, sidebar and top bar, project tabs, time-range control, filter chips, status/severity badges, pills, section labels and table headers, the sign-in feature panel |
| Normal selection | Page and card text, descriptions, table cells, log messages and attributes, incident details, form fields |
| `select-all` (one click selects the whole value) | One-time API key and signing secret, request IDs in the log detail, the SDK setup code block |

---

## 8. Layout and navigation

| Element | Spec |
|---|---|
| Page background | canvas `#fbf7ef` |
| Sidebar | 256 px wide, canvas fill, **2 px ink right border**. Logo block: 28 px pink square with 2 px ink border holding the activity icon, then "AOP" in Space Grotesk 700. |
| Sidebar group labels | 11 px uppercase Space Grotesk 700, fg-muted |
| Nav item (rest) | 14 px Space Grotesk 600, fg-secondary, transparent, radius 8 px, 2 px transparent border (no layout shift) |
| Nav item (hover) | white fill, 2 px ink border |
| Nav item (active) | lavender fill, 2 px ink border, `--shadow-sm`, ink text |
| Switchers (org, project) | white, 2 px ink border, radius 8 px, `--shadow-sm` |
| Top bar | 56 px, white, **2 px ink bottom border**, no blur |
| Theme toggle | segmented control: 2 px ink border; selected segment lavender |
| Avatar | 32 px circle, lavender-soft fill, 2 px ink border, initials in Space Grotesk 700 |
| Content | max width 1152 px, 32 px top padding; 24 px gap between cards |
| Project tabs | 14 px Space Grotesk 600; active tab: lavender fill, 2 px ink border, radius 8 px 8 px 0 0, sitting on the 2 px ink rule below |
| Breakpoints | < 1024 px: sidebar becomes a drawer (overlay `rgb(17 17 17 / 0.5)`), menu button in the top bar |

### 8.1 Sign-in and register

- Left panel (≥ 1024 px): **lavender** fill with 2 px ink right border; headline in Space
  Grotesk 700 40 px ink; feature list as white bordered cards with `--shadow-sm`; pink logo mark.
- Right panel: canvas; the form inside a white card (`--shadow-lg`).

---

## 9. Iconography

- Lucide icons with `strokeWidth={2.25}` (Lucide's default of 2 looks thin next to 2 px
  borders).
- Sizes: 14 px (badges, small buttons), 16 px (buttons, nav, banners), 20–22 px (empty states).
- Icons inherit `currentColor` (ink or the badge text colour). Never colour an icon with a status
  colour unless it sits inside its status badge.

---

## 10. Spacing scale

4-px base: 4, 8, 12, 16, 20, 24, 32, 48. Card padding 20; page gutters 16 (phone), 24 (tablet),
32 (desktop); grid gaps 16 (tiles), 24 (cards).

---

## 11. Accessibility checklist

- [ ] Every text pair is in the §3 table (≥ 4.5:1).
- [ ] Every interactive boundary has the 2 px ink border (≥ 3:1).
- [ ] Focus is visible on every control (3 px `#4527c9` outline or lavender-ink focus shadow).
- [ ] State = colour + icon + text, everywhere (badges, quota meters, freshness).
- [ ] Charts keep the legend (≥ 2 series) and the data-table view.
- [ ] `prefers-reduced-motion` removes press/hover movement.
- [ ] Hit targets ≥ 30 px high (sm buttons) and ≥ 36 px for primary actions.
- [ ] Skip-to-content link styled as a bordered white chip.

---

## 12. Do / don't

| Do | Don't |
|---|---|
| Put borders and shadows on frames and controls | Put borders, shadows, or colour inside chart plots or log lines |
| Use lavender for "primary" and "you are here" | Use yellow, orange, green, or red as decoration |
| Keep data on white with ink text | Put numbers on coloured tiles |
| Use the danger button only to *confirm* destruction | Make every delete button solid red |
| Use one primary button per area | Put several lavender buttons side by side |
| Use Space Grotesk for headings, numbers, buttons; Inter for reading | Set long paragraphs in Space Grotesk or mono |
| Keep shadows hard and bottom-right | Add blur, gradients, glassmorphism, or soft drop shadows |

---

## 13. Implementation plan (phase 1)

1. **Fonts:** add `@fontsource-variable/space-grotesk` and `@fontsource-variable/jetbrains-mono`;
   import them in `index.css`; expose `--font-display` and `--font-mono` theme tokens.
2. **Tokens:** in `index.css`, set the §2 colours and the §5 shape tokens on `:root` /
   `[data-theme='light']`. The dark block keeps today's values, and gets **its own** shape
   tokens (1 px borders, soft shadows, current radii, no movement), so dark mode keeps its look.
3. **Utilities:** expose shape tokens through Tailwind (`shadow-brutal`, `shadow-brutal-sm`,
   `shadow-brutal-lg`, `border-brutal`) so components never hard-code light-only values.
4. **Components** (`ui.tsx`, `StatusBadge.tsx`): implement §7.1–7.9, including the
   `danger-outline` variant, press/hover motion, and ink text on the good badge.
5. **Shell** (`AppLayout.tsx`, `AuthLayout.tsx`): §8.
6. **Pages:** swap any remaining one-off styles for the components; apply §7.10–7.11 to the
   dashboard and log explorer.
7. **Verify:** lint, typecheck, build, all tests; screenshot every page at 1440 px and 390 px in
   light mode, and confirm dark mode is visually unchanged; walk the §11 checklist.

---

## 14. Phase 2: dark neo-brutalist

Dark mode uses the same components, type, 2 px borders, radii, and press/lift motion as light.
Only the tokens in `[data-theme='dark']` differ (colours and shadow depth), so components carry
almost no `dark:` classes (the exceptions are the sign-in panel, §14.4, and the setup code block).

### 14.1 Surfaces and ink

| Token | Hex | Use |
|---|---|---|
| `--c-canvas` | `#000000` | Page background and sidebar (pure black) |
| `--c-surface` | `#1a1920` | Cards, inputs, tables, top bar, chart plots |
| `--c-subtle` | `#24222c` | Table header row, hover fill, code inside cards |
| `--c-ink` / `--c-line` | `#f2ede2` (cream) | **All borders** (black edges vanish on a dark canvas) |
| `--c-divider` | `#38354a` | Row dividers inside tables and lists only |
| `--c-fg` | `#f5f1e8` | Primary text |
| `--c-fg-secondary` | `#d6d1c6` | Body copy |
| `--c-fg-muted` | `#a9a49b` | Captions, hints, axis labels |

### 14.2 Accent and shadows

| Token | Value | Note |
|---|---|---|
| `--c-accent` | `#4821a3` (deep violet) | Primary buttons, active nav item and tab, selected segment, checked chips |
| `--c-accent-fg` | `#ffffff` | Text on violet is **white** (ink would be 1.8:1) |
| `--c-accent-hover` | `#5a2fc2` | Brighter on hover |
| `--c-accent-soft` | `#22163f` | Selected row, icon tiles, Owner badge |
| `--c-accent-text` | `#c4b0ff` | Links, focus outline (violet itself is too dark for text) |
| `--c-pink` / `--c-sky` | `#ff90e8` / `#a5dcff` | Unchanged; small areas only, with ink text (the logo icon is fixed to `#111111`) |
| Hard shadows | **light violet `#8a63e6`** | Lighter than the fill so a button's shadow stays visible next to it |
| Shadow depth | chip 3 px, control 4 px (hover 5), card 6 px (hover 9) | One step deeper than light (2/3/5) for depth on black; press-in 4 px |
| Input focus shadow | `3px 3px 0 #ff90e8` (pink) | Distinct from the violet object shadows |

The accent was chosen after comparing lavender, steel, cream, cyan, and several purples: deep
violet is the furthest from every status colour (OKLab ΔE ≥ 33.6) and from the chart series
(ΔE ≥ 25.1), so firing incidents, errors, and chart lines remain the loudest things on screen.

Status colours (§2.3) are identical in both themes; their badges keep a cream border.

### 14.3 Feedback banners

| Tone | Fill | Text | Ratio |
|---|---|---|---|
| error | `#361513` | `#ffb3aa` | 9.64 |
| warning | `#2c2210` | `#ffd27a` | 10.98 |
| success | `#0f2a1e` | `#8be0b2` | 9.78 |
| info | `#152737` | `#bfe4ff` | 11.44 |

Banners and secret boxes use tinted dark fills (not the light theme's bright fills) to avoid glare;
all have the 2 px cream border, and secret boxes keep the 6 px pink left edge.

### 14.4 Glare rules

- Violet stays on small, meaningful areas: primary buttons, the active nav item and tab, the
  selected segment, checked chips, and shadows.
- The sign-in panel is a **surface** fill in dark (a full-height accent panel would glare), with
  feature cards on `--c-subtle`.

### 14.5 Charts

- Plot on `#1a1920` with the dark series palette `#3987e5`, `#d95926`, `#199e70`, re-validated
  against this surface: all checks pass (worst adjacent CVD ΔE 9.4, normal-vision ΔE 26.5, every
  series ≥ 3:1).
- Gridlines `#2c2a35`, axis `#4a4658`, ticks fg-muted.
- Tooltip: surface fill, 2 px cream border, `3px 3px 0 #8a63e6` shadow.

### 14.6 Contrast (measured, WCAG 2.2)

| Foreground | Background | Ratio | Needs |
|---|---|---|---|
| fg `#f5f1e8` | canvas `#000000` / surface / subtle | 18.63 / 15.48 / 13.90 | 4.5 |
| fg-secondary `#d6d1c6` | canvas / surface / subtle | 13.79 / 11.46 / 10.29 | 4.5 |
| fg-muted `#a9a49b` | canvas / surface / subtle | 8.47 / 7.04 / 6.32 | 4.5 |
| white | accent `#4821a3` / hover `#5a2fc2` | 10.39 / 8.01 | 4.5 |
| fg / fg-muted | accent-soft `#22163f` | 14.85 / 6.75 | 4.5 |
| accent-text `#c4b0ff` | canvas / surface / subtle / accent-soft | 11.00 / 9.14 / 8.21 / 8.77 | 4.5 |
| white | critical `#d03b3b` | 4.80 | 4.5 |
| setup code `#f2ede2` | `#0c0b10` | 16.80 | 4.5 |
| cream border `#f2ede2` | canvas / surface | 17.99 / 14.94 | 3 (boundary) |
| violet shadow `#8a63e6` | canvas / surface / accent fill | 5.01 / 4.16 / 2.48 | Decorative (the border is the boundary) |
| focus `#c4b0ff` / pink `#ff90e8` | canvas | 11.00 / 10.41 | 3 |
| divider `#38354a` | surface | 1.48 | Decorative only |
