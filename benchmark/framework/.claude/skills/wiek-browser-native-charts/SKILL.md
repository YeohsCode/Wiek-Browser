---
name: wiek-browser-native-charts
description: Generate self-contained HTML/CSS benchmark and comparison charts in an wiek-inspired Browser-Native Editorial style. Use for blue-white product metrics, model benchmarks, A/B comparisons, efficiency reports, difficulty breakdowns, and compact technical data panels.
---

# Wiek Browser-Native Charts

Generate data charts that look like a restrained, product-native browser interface rather than a generic AI dashboard.

## Style Identity

Use the name **Browser-Native Editorial Benchmark** for this visual system.

It combines:

- browser chrome and tab geometry;
- editorial hierarchy and generous white space;
- technical benchmark conventions;
- monochrome surfaces with one functional blue accent;
- compact monospace metadata and metric labels;
- thin borders, flat fills, and minimal decoration.

The result should feel like a benchmark page built into a browser product: calm, precise, utilitarian, and brand-led.

## When to Use

Use this skill when the user asks for:

- product or model benchmark comparisons;
- REPL versus Heredoc, baseline versus target, or competitor versus product charts;
- cost, latency, token, tool-call, turn-count, success-rate, or percentile metrics;
- blue-and-white technical charts;
- an wiek-lite-like browser-native or editorial chart style;
- self-contained HTML sections that can be pasted into a blog, landing page, or report.

Do not use this style for playful consumer dashboards, colorful marketing infographics, 3D charts, glossy gradients, or dense financial terminals.

## Output Contract

Unless the user requests otherwise:

1. Output one complete self-contained `<section>` block.
2. Put all CSS inside a nested `<style>` element.
3. Use no JavaScript and no external libraries.
4. Namespace every class with a unique component prefix.
5. Keep the component responsive.
6. Preserve all supplied data exactly unless a derived percentage must be recalculated.
7. Use English interface copy by default when the surrounding article is English; otherwise match the user’s language.
8. Do not add explanations before or after the code when the user asks for code only.

## Core Design Tokens

Use these defaults unless the user gives explicit brand tokens:

```css
--wiek-blue: #2457ff;
--wiek-black: #161616;
--wiek-surface: #f6f6f3;
--wiek-line: #d8d8d3;
--wiek-muted: #777772;
--wiek-white: #ffffff;
```

### Color Roles

- `--wiek-blue`: target product, improvement, selected state, positive efficiency signal.
- `--wiek-black`: primary title, model metadata, axes, important values.
- `--wiek-surface`: browser chrome, chart card interiors, subtle rows.
- `--wiek-line`: borders, separators, tracks, and grid lines.
- `--wiek-muted`: descriptions, run metadata, secondary labels.
- Baseline bars: light neutral gray with a thin gray border.
- Target bars: solid brand blue with no gradient.

Never use neon glow, purple gradients, glassmorphism, heavy shadows, or multicolor palettes.

## Typography

Use system sans-serif for editorial copy and system monospace for technical labels.

```css
font-family: Arial, Helvetica, -apple-system, BlinkMacSystemFont,
  "Segoe UI", sans-serif;
```

```css
font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
```

Recommended scale for a component around 920 px wide:

- main title: `14px`, weight `700`;
- description: `10px`, muted;
- metric header: `9–9.5px`, monospace, weight `600`;
- value labels: `9.5–10px`, monospace, weight `600`;
- category labels: `8–9px`;
- metadata: `8–8.5px`, monospace;
- model metadata: `8.5px`, monospace, black, weight `600`.

Avoid oversized dashboard typography. Titles should be short and compact.

## Browser Shell

The default outer structure is:

1. a 34 px browser chrome row;
2. three small circular controls;
3. one active tab with a 6 px blue square;
4. a content area with title on the left and model/run metadata on the right;
5. one or more bordered chart panels;
6. a small footer such as `lower is better`.

Recommended shell styling:

- outer border: `1px solid #161616`;
- outer radius: `10px`;
- card radius: `7px`;
- no drop shadow;
- active tab bottom border blends into white content;
- browser chrome uses `#f6f6f3`.

If the user asks to remove the browser shell, keep the same internal cards, typography, tokens, and spacing, but remove only the chrome row and outer browser frame.

## Model Metadata

When model and effort information is available, place it at the upper right of the content header.

Preferred copy:

```text
model gpt-5.5 · effort medium
```

Rules:

- render it in monospace;
- use `--wiek-black`, not muted gray;
- use weight `600`;
- keep run/sample metadata on a second line in `--wiek-muted`;
- do not turn it into a pill, badge, button, or colored chip;
- keep it horizontally aligned with the title block.

## Data Semantics and Percentage Math

Choose one comparison direction and keep it consistent throughout a component.

### Default comparison language

Prefer target-relative reduction language:

```text
21.6% lower
44.0% lower
```

Use this formula when comparing a lower target value against a baseline:

```text
reduction_percent = (baseline - target) / baseline × 100
```

Example:

```text
baseline = 43.65
target = 24.43
reduction = (43.65 - 24.43) / 43.65 = 44.0%
```

Do not mix this with “baseline increase over target,” which uses a different denominator:

```text
increase_percent = (baseline - target) / target × 100
```

If the supplied table contains `REPL +78.7%` but the chart is meant to follow the `X% lower` convention, recompute the value using the baseline denominator and relabel it. Mention the conversion only when explanatory prose is requested.

For metrics where higher is better, use `X% higher` or `+X pp` and state `higher is better` in the footer.

## Chart Selection Rules

### 1–2 metrics: Dual Card Bars

Use two side-by-side cards. Each card contains two vertical bars:

- baseline on the left in neutral gray;
- target product on the right in brand blue;
- values above each bar;
- reduction label in the card header;
- shared footer: `lower is better`.

### 3–5 related metrics: Hybrid Panel

Use:

- one large primary vertical-bar comparison on the left;
- difficulty or subgroup rows with paired horizontal tracks on the right;
- compact summary statistics below.

This is the preferred layout for overall plus Easy/Medium/Hard data.

### 6–10 metrics: Benchmark Report Rows

Use grouped horizontal rows rather than many miniature vertical charts.

Each row should show:

- metric name;
- baseline and target values;
- a pair of horizontal tracks;
- one consistently defined delta.

### Time series

Use a simple line chart with thin black/gray baseline and solid blue target. Keep the browser shell and compact metadata, but do not force time-series data into bars.

## Bar and Track Grammar

### Vertical bars

- baseline: `background: #dededa; border: 1px solid #a2a29d;`;
- target: `background: #2457ff;`;
- top corners: `2px` radius;
- no gradients;
- baseline height is usually `100%` within each metric card;
- target height is `target / baseline × 100%`;
- do not compare bar heights across cards with different units.

### Horizontal tracks

- track background: `#e2e2de` or `#ecece8`;
- track height: `5–7px`;
- baseline fill: gray with thin border;
- target fill: solid blue;
- square ends or at most 1–2 px radius;
- place exact values at the right edge.

### Grid lines

Use thin, low-contrast horizontal lines. A repeating linear gradient is acceptable:

```css
background-image: repeating-linear-gradient(
  to bottom,
  transparent 0,
  transparent 41px,
  #e3e3df 41px,
  #e3e3df 42px
);
```

Axes should be black or medium gray, never blue.

## Copywriting Rules

Use short, factual, product-oriented titles:

- `Same workload. Fewer calls.`
- `Less back-and-forth at every level.`
- `Nearly half the interaction turns.`
- `Same tasks. Lower overhead.`

Descriptions should explain the comparison in one sentence and avoid hype.

Metric labels should be compact and technical:

- `AVG_COST_USD`
- `AVG_TOOL_CALLS`
- `OVERALL_AVERAGE`
- `AVERAGE_BY_DIFFICULTY`
- `TOTAL_TURNS`
- `OVERALL_P95`

Use sentence case only for editorial titles and descriptions. Use uppercase monospace labels for metric identifiers.

## Layout and Spacing

Default component:

```css
width: 100%;
max-width: 920px;
margin: 26px auto;
```

Typical spacing:

- content padding: `15px 16px 14px`;
- header bottom margin: `12–13px`;
- panel gap: `10px`;
- panel header padding: `8px 10px`;
- chart body padding: `11–13px`;
- summary gap: `10px`.

Preserve white space. Do not compress every region into a dense dashboard.

## Responsive Behavior

At `640–700px`:

- stack two-column panels into one column;
- move right-side metadata under the title and align it left;
- stack summary cards vertically;
- keep chart labels readable;
- never allow model metadata or values to overlap.

Use media queries inside the component. Do not rely on page-level CSS.

## Accessibility and Robustness

- Maintain readable contrast between blue, black, gray, and white.
- Do not communicate comparison using color alone; include values and labels.
- Use semantic elements such as `header`, `article`, `aside`, and `footer` when practical.
- Add `aria-label` to the root section when the chart’s meaning is not obvious from surrounding context.
- Keep tabular numbers aligned with `font-variant-numeric: tabular-nums`.
- Do not use absolute positioning for important content unless necessary.

## Anti-Patterns

Do not generate:

- glowing blue bars;
- large rounded pills for deltas;
- gradients on chart bars;
- floating glass cards;
- colorful legends with many accent colors;
- giant headings or oversized KPI numerals;
- icons that add no data meaning;
- fake browser controls that dominate the content;
- inconsistent percentage denominators;
- a gray model label when the corresponding component uses black metadata.

## Generation Workflow

1. Parse the user’s table and identify baseline, target, unit, grouping, and direction of improvement.
2. Verify every derived percentage with the correct denominator.
3. Choose a layout based on metric count.
4. Write one concise title and one factual description.
5. Add model and run metadata when available.
6. Apply the design tokens and browser shell.
7. Use neutral gray for baseline and blue for target.
8. Add an explicit `lower is better` or `higher is better` footer.
9. Add responsive CSS.
10. Check the final output against the quality checklist.

## Quality Checklist

Before returning the HTML, verify:

- [ ] All input values are present and correct.
- [ ] Every percentage uses one consistent comparison direction.
- [ ] Baseline is gray and target is blue.
- [ ] Model metadata is black and semibold.
- [ ] Secondary metadata is muted gray.
- [ ] No gradients, glow, glassmorphism, or heavy shadow are present.
- [ ] Metric identifiers use compact monospace styling.
- [ ] The browser shell is visually subordinate to the data.
- [ ] The chart remains usable on narrow screens.
- [ ] Every class is namespaced.
- [ ] The output is self-contained HTML/CSS with no JavaScript.

## Reference Templates

Use the templates bundled with this skill as starting points:

- `templates/browser-native-dual-card.html`: two-metric side-by-side comparison.
- `templates/browser-native-hybrid.html`: overall metric plus subgroup/difficulty breakdown.

Replace placeholders carefully; do not change the design language unless the user asks.
