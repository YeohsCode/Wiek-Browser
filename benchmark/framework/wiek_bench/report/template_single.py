"""Single-run report template with an academic technical-paper visual style.

Adapted from tmp/webui-proposals/report-single-c-print.html. Pure presentation:
the payload contract lives in compare.build_payload. Tokens
``__DOC_TITLE__`` / ``__REPORT_LANG__`` / ``__REPORT_MESSAGES__`` /
``__PAYLOAD__`` are substituted by compare.render_html via str.replace
(no str.format — the CSS/JS braces stay literal).

Sample durations use ``fmtClock`` while summary bands and numeric detail tables
retain seconds for downstream analysis.
"""

TEMPLATE = r"""<!DOCTYPE html>
<html lang="__REPORT_LANG__">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>__DOC_TITLE__</title>
<style>
  /* Academic technical-paper visual style. */
  :root {
    --bg:        #e8e4d8;   /* Desktop background. */
    --paper:     #fcfaf3;   /* Warm paper surface. */
    --ink:       #1c1a16;   /* Primary ink. */
    --ink-soft:  #5a5347;   /* Secondary ink. */
    --ink-faint: #8a8273;
    --hairline:  #cfc8b6;   /* Fine rule. */
    --rule:      #1c1a16;   /* Heavy rule. */
    --accent:    #963a25;   /* Dark brick red. */
    --accent-bg: #f3e7e1;
    --ok:        #3d6b3f;
    --ok-bg:     #e8efe4;
    --amber:     #946a00;   /* Human-verification block — warns without reading as failure. */
    --amber-bg:  #f4ecd2;
    --serif: Georgia, "New York", "Times New Roman", "Songti SC", "SimSun", serif;
    --sans: -apple-system, BlinkMacSystemFont, "Segoe UI", "Helvetica Neue", "PingFang SC", sans-serif;
    --mono: ui-monospace, "SF Mono", Menlo, Consolas, "Courier New", monospace;
  }
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html { background: var(--bg); }
  body {
    font-family: var(--sans);
    color: var(--ink);
    font-size: 13px;
    line-height: 1.65;
    -webkit-font-smoothing: antialiased;
  }
  .sheet {
    max-width: 880px;
    margin: 44px auto 72px;
    background: var(--paper);
    padding: 58px 68px 48px;
    box-shadow: 0 1px 3px rgba(28,26,22,.18), 0 14px 44px rgba(28,26,22,.14);
  }

  /* Header. */
  .masthead {
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: var(--mono); font-size: 10px; letter-spacing: .14em;
    text-transform: uppercase; color: var(--ink-soft);
    padding-bottom: 8px;
  }
  .masthead .no { color: var(--accent); }
  .rule-thick { border: 0; border-top: 2.5px solid var(--rule); margin: 0 0 2px; }
  .rule-thin  { border: 0; border-top: 1px solid var(--rule); }
  .rule-hair  { border: 0; border-top: 1px solid var(--hairline); }

  h1 {
    font-family: var(--serif); font-weight: 600;
    font-size: 27px; line-height: 1.3; letter-spacing: .01em;
    margin: 30px 0 6px;
  }
  .subtitle { font-family: var(--mono); font-size: 11px; color: var(--ink-soft); word-break: break-all; }
  .byline {
    margin-top: 14px; font-size: 12px; color: var(--ink-soft);
    font-family: var(--serif); font-style: italic;
  }
  .byline b { font-style: normal; color: var(--ink); font-weight: 600; }

  /* Abstract. */
  .abstract {
    margin: 30px 36px 0;
    padding: 16px 0 14px;
    border-top: 1px solid var(--rule);
    border-bottom: 1px solid var(--hairline);
  }
  .abstract .ab-label {
    font-family: var(--serif); font-weight: 700; font-size: 12px;
    letter-spacing: .22em; text-transform: uppercase; margin-bottom: 8px;
  }
  .abstract p { font-size: 12.5px; color: var(--ink); text-align: justify; }
  .abstract .num { font-family: var(--mono); font-size: 11.5px; font-weight: 600; color: var(--accent); }

  /* Section headings. */
  h2 {
    font-family: var(--serif); font-weight: 700; font-size: 17px;
    margin: 44px 0 4px; letter-spacing: .01em;
  }
  h2 .sec-no { color: var(--accent); margin-right: 10px; font-variant-numeric: tabular-nums; }
  h2 .en { font-weight: 400; font-style: italic; font-size: 12px; color: var(--ink-faint); margin-left: 10px; letter-spacing: .04em; }
  .sec-desc { font-size: 11.5px; color: var(--ink-soft); margin-bottom: 14px; }

  /* Collapsible sections open when their headings are clicked. */
  details.fold > summary { list-style: none; cursor: pointer; display: block; }
  details.fold > summary::-webkit-details-marker { display: none; }
  details.fold > summary h2::after {
    content: "▸ " attr(data-expand-label); font-family: var(--mono); font-weight: 400; font-size: 10px;
    letter-spacing: .08em; color: var(--ink-faint); margin-left: 14px; vertical-align: 2px;
  }
  details.fold[open] > summary h2::after { content: "▾ " attr(data-collapse-label); }
  details.fold > summary:hover h2::after { color: var(--accent); }

  /* Metadata. */
  .meta-grid {
    display: grid; grid-template-columns: 1fr 1fr; gap: 0 40px;
    border-top: 2px solid var(--rule); margin-top: 10px;
  }
  .meta-grid dl { display: grid; grid-template-columns: 112px 1fr; }
  .meta-grid dt {
    font-size: 10px; letter-spacing: .1em; text-transform: uppercase;
    color: var(--ink-soft); padding: 7px 0 6px; border-bottom: 1px solid var(--hairline);
    font-family: var(--mono);
  }
  .meta-grid dd {
    font-size: 12px; padding: 6px 0 5px; border-bottom: 1px solid var(--hairline);
    font-family: var(--mono); word-break: break-all;
  }
  details.dropped { margin-top: 10px; }
  details.dropped summary {
    cursor: pointer; font-family: var(--mono); font-size: 11px; color: var(--accent);
    list-style: none; display: inline-block;
    border-bottom: 1px dashed var(--accent); padding-bottom: 1px;
  }
  details.dropped summary::-webkit-details-marker { display: none; }
  details.dropped summary::before { content: "▸ "; }
  details.dropped[open] summary::before { content: "▾ "; }
  .dropped-tbl { margin-top: 8px; }

  /* Academic three-line table. */
  .figcap, .tabcap {
    text-align: center; font-family: var(--serif); font-size: 11.5px;
    color: var(--ink); margin: 6px 0 8px;
  }
  .tabcap b, .figcap b { font-weight: 700; letter-spacing: .06em; }
  table { width: 100%; border-collapse: collapse; }
  table.three-line { border-top: 2px solid var(--rule); border-bottom: 2px solid var(--rule); }
  table.three-line thead th {
    font-family: var(--sans); font-weight: 600; font-size: 10.5px;
    letter-spacing: .07em; text-transform: uppercase; color: var(--ink-soft);
    padding: 7px 8px 6px; border-bottom: 1px solid var(--rule); text-align: right;
    white-space: nowrap;
  }
  table.three-line thead th:first-child { text-align: left; }
  table.three-line td {
    padding: 6px 8px; font-size: 12px; text-align: right;
    font-family: var(--mono); font-variant-numeric: tabular-nums;
    border-bottom: 1px solid transparent;
  }
  table.three-line tbody tr + tr td { border-top: 1px dotted var(--hairline); }
  table.three-line td:first-child { text-align: left; }
  .dim { color: var(--ink-faint); }
  .small { font-size: 10.5px; }

  /* Summary metric band. */
  .stat-band {
    display: grid; grid-template-columns: repeat(4, 1fr);
    border-top: 2px solid var(--rule); border-bottom: 1px solid var(--rule);
    margin-top: 10px;
  }
  .stat {
    padding: 12px 14px 11px; border-right: 1px solid var(--hairline);
  }
  .stat:nth-child(4n) { border-right: none; }
  .stat:nth-child(n+5) { border-top: 1px solid var(--hairline); }
  .stat .k {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink-soft); display: block;
  }
  .stat .v {
    font-family: var(--serif); font-size: 22px; font-weight: 600;
    font-variant-numeric: tabular-nums; line-height: 1.25; display: block; margin-top: 2px;
  }
  .stat .v small { font-size: 11px; font-family: var(--mono); font-weight: 400; color: var(--ink-soft); margin-left: 2px; }
  .stat .sub { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); display: block; }
  .stat.accent .v { color: var(--accent); }

  /* Letterpress-style bar chart. */
  figure.barfig { margin: 14px 0 0; }
  .bar-row { display: grid; grid-template-columns: 168px 1fr 76px; align-items: center; padding: 3.5px 0; }
  .bar-row .lbl { font-family: var(--mono); font-size: 10.5px; color: var(--ink); padding-right: 12px; text-align: right; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .bar-row .lbl .it { color: var(--ink-faint); }
  .bar-track { position: relative; height: 7px; background: transparent; border-left: 1px solid var(--rule); }
  .bar-fill { position: absolute; left: 0; top: 0; bottom: 0; background: var(--ink); }
  .bar-fill.red { background: var(--accent); }
  .bar-fill.hatch {
    background: repeating-linear-gradient(45deg, var(--ink) 0 2px, transparent 2px 4px);
  }
  .bar-row .val { font-family: var(--mono); font-size: 10.5px; text-align: right; font-variant-numeric: tabular-nums; padding-left: 10px; white-space: nowrap; }
  .stack-track { display: flex; height: 12px; border: 1px solid var(--rule); background: var(--paper); }
  .stack-seg { height: 100%; }
  .bar-group-title {
    font-family: var(--sans); font-size: 10px; font-weight: 600; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink-soft); margin: 12px 0 4px;
    border-bottom: 1px solid var(--hairline); padding-bottom: 3px;
  }
  .fig-cols { display: grid; grid-template-columns: 1fr 1fr 1fr; gap: 0 26px; }
  .legend { font-family: var(--mono); font-size: 9.5px; color: var(--ink-faint); text-align: center; margin-top: 8px; }
  .legend .sw { display: inline-block; width: 16px; height: 6px; vertical-align: 0; margin: 0 4px 0 12px; }

  /* Individual samples. */
  .sample { border-top: 1px solid var(--hairline); padding: 12px 0 12px; }
  .sample:first-of-type { border-top: 1px solid var(--rule); }
  .sample-head { display: flex; flex-wrap: wrap; align-items: baseline; gap: 8px 14px; }
  .tid {
    font-family: var(--mono); font-size: 12px; font-weight: 600; color: var(--accent);
    text-decoration: none; border-bottom: 1px dashed var(--accent);
  }
  .tid:hover { background: var(--accent-bg); }
  .shot-badge { font-size: 12px; text-decoration: none; line-height: 1; opacity: .7; }
  .shot-badge:hover { opacity: 1; }
  .tag {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
    color: var(--ink-soft); border: 1px solid var(--hairline); padding: 0 6px; line-height: 16px;
  }
  .badge {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em; text-transform: uppercase;
    padding: 0 7px; line-height: 17px; font-weight: 700;
  }
  .badge.pass { color: var(--ok); background: var(--ok-bg); border: 1px solid var(--ok); }
  .badge.fail { color: var(--accent); background: var(--accent-bg); border: 1px solid var(--accent); }
  .badge.flag { color: var(--ink-soft); background: transparent; border: 1px dashed var(--ink-faint); }
  .badge.captcha { color: var(--amber); background: var(--amber-bg); border: 1px solid var(--amber); }
  .sample-metrics {
    font-family: var(--mono); font-size: 11px; color: var(--ink);
    margin-left: auto; font-variant-numeric: tabular-nums; white-space: nowrap;
  }
  .sample-metrics b { font-weight: 600; }
  .sample-metrics .sep { color: var(--hairline); margin: 0 6px; }
  .kv-line { margin-top: 6px; font-size: 11px; display: flex; gap: 10px; }
  .kv-line .k {
    flex: none; width: 46px; font-family: var(--mono); font-size: 9px; letter-spacing: .12em;
    text-transform: uppercase; color: var(--ink-faint); padding-top: 2px; text-align: right;
  }
  .kv-line .chain { font-family: var(--mono); font-size: 10.5px; color: var(--ink-soft); word-break: break-all; }
  .kv-line .chain .arrow { color: var(--accent); }
  .kv-line .final { font-size: 12px; color: var(--ink); text-align: justify; }
  /* Collapse failure details to one summary line and expand rubric details in place. */
  .fr { margin-top: 6px; margin-left: 56px; border-top: 1px solid var(--hairline); padding-top: 6px; }
  .fr summary { list-style: none; cursor: pointer; display: flex; align-items: center; flex-wrap: wrap; gap: 6px; font-size: 11px; color: var(--accent); user-select: none; }
  .fr summary::-webkit-details-marker { display: none; }
  .fr summary .chev { font-family: var(--mono); font-size: 9.5px; display: inline-block; transition: transform .15s; }
  .fr[open] summary .chev { transform: rotate(90deg); }
  .fr summary:hover { text-decoration: underline; text-underline-offset: 2px; }
  .fr .fr-label { font-family: var(--mono); font-size: 9.5px; letter-spacing: .05em; }
  .fr .fr-body { margin-top: 6px; }
  .fr .fr-item { display: grid; grid-template-columns: 30px 1fr; gap: 8px; font-size: 11px; color: var(--ink-soft); line-height: 1.6; padding: 4px 0; border-top: 1px solid var(--hairline); }
  .fr .fr-item:first-child { border-top: none; }
  .rubric-tag { font-family: var(--mono); font-size: 9px; font-weight: 600; color: #fff; background: var(--accent); padding: 0 5px; border-radius: 2px; letter-spacing: .02em; }
  .rubric-tag.ghost { background: transparent; color: var(--accent); border: 1px solid #c98b7a; }   /* Brick-red summary chip. */
  .rubric-tag.ghost-ok { background: transparent; color: var(--ok); border: 1px solid #8aa98a; }    /* Green passing summary chip. */
  .rubric-tag.ok { background: var(--ok); border-color: var(--ok); }                                /* Solid green passing chip. */
  a.rubric-tag.ra-link { color: #fff; text-decoration: none; cursor: pointer; line-height: 15px; display: inline-flex; align-items: center; }
  a.rubric-tag.ra-link:hover { filter: brightness(1.12); box-shadow: 0 1px 4px rgba(28,26,22,.25); }
  .rubric-tag .ra-ext { font-size: 8px; margin-left: 3px; opacity: .85; }
  /* Each structured Odysseys rubric collapses to one header row. Clicking the row
     toggles its reasoning, while the numbered link opens the judge session. */
  .fr-body.ra-acc { margin-top: 6px; border-top: 1px solid var(--hairline); }
  .acc-item { border-bottom: 1px solid var(--hairline); }
  .acc-head { display: flex; align-items: center; gap: 10px; padding: 7px 2px; cursor: pointer; user-select: none; }
  .acc-head:hover { background: rgba(150,58,37,.05); }
  .acc-status { font-family: var(--mono); font-size: 9px; font-weight: 700; letter-spacing: .05em; text-transform: uppercase; }
  .acc-status.fail { color: var(--accent); }
  .acc-status.ok { color: var(--ok); }
  .acc-conf { font-family: var(--mono); font-size: 8.5px; color: var(--ink-faint); letter-spacing: .04em; }
  .acc-peek { flex: 1; min-width: 0; font-size: 11px; color: var(--ink-soft); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .acc-chev { font-family: var(--mono); font-size: 10px; color: var(--ink-faint); transition: transform .15s; }
  .acc-item.open .acc-chev { transform: rotate(90deg); }
  .acc-item.open .acc-peek { visibility: hidden; }
  .acc-body { display: none; padding: 2px 2px 12px 2px; }
  .acc-item.open .acc-body { display: block; }
  .ra-req { font-size: 11px; color: var(--ink); margin-bottom: 5px; }
  .ra-req b { font-family: var(--mono); font-size: 8.5px; letter-spacing: .06em; text-transform: uppercase; color: var(--ink-faint); font-weight: 700; margin-right: 5px; }
  .ra-reason { font-size: 11px; color: var(--ink-soft); line-height: 1.6; white-space: pre-wrap; }
  .expand-btn {
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .08em;
    background: none; border: 1px solid var(--ink-soft); color: var(--ink-soft);
    padding: 0 7px; line-height: 16px; cursor: pointer; margin-left: 8px; vertical-align: 1px;
  }
  .expand-btn:hover { border-color: var(--accent); color: var(--accent); }

  /* Numeric detail table. */
  .detail-wrap { overflow-x: auto; }
  table.detail td, table.detail th { font-size: 10.5px; padding: 4px 7px; }
  table.detail td { font-family: var(--mono); white-space: nowrap; }
  /* Draw separators at base-task group boundaries rather than at fixed intervals. */
  table.detail tbody tr.task-sep td { border-bottom: 1px solid var(--hairline); }

  /* Footer. */
  .foot {
    margin-top: 52px; padding-top: 8px;
    display: flex; justify-content: space-between; align-items: baseline;
    font-family: var(--mono); font-size: 9.5px; letter-spacing: .1em;
    text-transform: uppercase; color: var(--ink-faint);
  }
  .foot .pg { font-family: var(--serif); font-style: italic; text-transform: none; letter-spacing: .3em; }

  /* Print layout. */
  @media print {
    html, body { background: #fff; }
    .sheet { max-width: none; margin: 0; padding: 10mm 12mm; box-shadow: none; }
    .expand-btn { display: none; }
    .ft-more { display: inline !important; }   /* Expand full text when printing. */
    details.fold > summary h2::after { content: none; }   /* Hide expansion hints when printing. */
    /* Force folded sections open for print. Cover both modern Chromium's
       ::details-content behavior and the display:none behavior used elsewhere. */
    details.fold::details-content { content-visibility: visible !important; }
    details.fold:not([open]) > :not(summary) { display: revert; }
    .sample, figure.barfig, table { break-inside: avoid; }
    h2 { break-after: avoid; }
    a.tid { color: var(--ink); border-bottom-color: var(--ink); }
    /* Shrink the wide detail table and allow task ids to wrap when printing. */
    table.detail td, table.detail th { font-size: 8px; padding: 3px 4px; }
    table.detail td:nth-child(2) { white-space: normal; word-break: break-all; }
  }
  @page { margin: 14mm; }

  @media (max-width: 720px) {
    .sheet { padding: 28px 20px; margin: 0; }
    .stat-band { grid-template-columns: repeat(2, 1fr); }
    .stat:nth-child(2n) { border-right: none; }
    .stat:nth-child(n+3) { border-top: 1px solid var(--hairline); }
    .fig-cols { grid-template-columns: 1fr; }
    .meta-grid { grid-template-columns: 1fr; }
  }
</style>
</head>
<body>
<div class="sheet">

  <!-- Header. -->
  <header>
    <div class="masthead">
      <span>WIEK BENCHMARK HARNESS · TECHNICAL REPORT</span>
      <span class="no" id="hd-no"></span>
    </div>
    <hr class="rule-thick">
    <hr class="rule-thin">
    <h1 id="hd-title"></h1>
    <div class="subtitle" id="hd-runid"></div>
    <div class="byline" id="hd-byline"></div>
  </header>

  <!-- Abstract. -->
  <section class="abstract" id="abstract">
    <div class="ab-label" data-i18n="abstract_label"></div>
    <p id="ab-text"></p>
  </section>

  <!-- Run metadata. -->
  <section>
    <h2>
      <span class="sec-no">1</span><span data-i18n="section_metadata"></span>
      <span class="en" data-i18n="section_metadata_secondary"></span>
    </h2>
    <div class="meta-grid" id="meta-grid"></div>
    <details class="dropped" id="dropped-box"></details>
  </section>

  <!-- Aggregate metrics. -->
  <section>
    <h2>
      <span class="sec-no">2</span><span data-i18n="section_aggregate"></span>
      <span class="en" data-i18n="section_aggregate_secondary"></span>
    </h2>
    <p class="sec-desc" data-i18n="aggregate_description"></p>
    <div class="tabcap">
      <b data-i18n="table_1"></b> <span data-i18n="aggregate_caption"></span>
      (n = <span id="t1-n"></span>)
    </div>
    <div class="stat-band" id="stat-band"></div>

    <div id="latency-block">
      <div class="tabcap" style="margin-top:28px">
        <b data-i18n="table_2"></b> <span data-i18n="latency_caption"></span>
      </div>
      <p
        class="sec-desc"
        style="margin:0 0 6px"
        data-i18n="latency_description"
      ></p>
      <div class="detail-wrap"><table class="three-line" id="latency-tbl"></table></div>
      <figure class="barfig" style="margin-top:10px">
        <div class="stack-track" id="latency-stack"></div>
        <div class="legend" id="latency-legend"></div>
        <figcaption class="figcap">
          <b data-i18n="figure_1"></b> <span data-i18n="latency_figure_caption"></span>
        </figcaption>
      </figure>
    </div>
  </section>

  <!-- Dataset-specific modules are injected by render_html. -->
__MODULE_SECTIONS__

  <!-- Per-iteration means. -->
  <section id="sec-iter">
    <h2>
      <span class="sec-no">3</span><span data-i18n="section_iteration"></span>
      <span class="en" data-i18n="section_iteration_secondary"></span>
    </h2>
    <p class="sec-desc" data-i18n="iteration_description"></p>
    <figure class="barfig">
      <div class="fig-cols" id="iter-cols"></div>
      <figcaption class="figcap">
        <b data-i18n="figure_2"></b> <span data-i18n="iteration_figure_caption"></span>
      </figcaption>
    </figure>
  </section>

  <!-- Per-base-task means. -->
  <section id="sec-perbase">
    <details class="fold">
    <summary>
      <h2>
        <span class="sec-no">4</span><span data-i18n="section_per_task"></span>
        <span class="en" data-i18n="section_per_task_secondary"></span>
      </h2>
    </summary>
    <p class="sec-desc" data-i18n="per_task_description"></p>
    <figure class="barfig">
      <div class="tabcap">
        <b data-i18n="table_3"></b> <span data-i18n="per_task_caption"></span>
      </div>
      <div class="detail-wrap"><table class="three-line" id="perbase-tbl"></table></div>
      <div class="legend">
        <span class="sw" style="background:var(--ink)"></span>duration_avg
        <span class="sw" style="background:var(--accent)"></span>cost_avg
        <span class="sw" style="background:repeating-linear-gradient(45deg,var(--ink) 0 2px,transparent 2px 4px)"></span>tools_avg
      </div>
      <figcaption class="figcap">
        <b data-i18n="figure_3"></b> <span data-i18n="per_task_figure_caption"></span>
      </figcaption>
    </figure>
    </details>
  </section>

  <!-- Individual samples. -->
  <section>
    <details class="fold">
    <summary>
      <h2>
        <span class="sec-no">5</span><span data-i18n="section_samples"></span>
        <span class="en" data-i18n="section_samples_secondary"></span>
      </h2>
    </summary>
    <p class="sec-desc" data-i18n="samples_description"></p>
    <div id="samples"></div>
    </details>
  </section>

  <!-- Numeric detail table. -->
  <section>
    <details class="fold">
    <summary>
      <h2>
        <span class="sec-no">6</span><span data-i18n="section_detail"></span>
        <span class="en" data-i18n="section_detail_secondary"></span>
      </h2>
    </summary>
    <p class="sec-desc" data-i18n="detail_description"></p>
    <div class="tabcap">
      <b data-i18n="table_4"></b> <span data-i18n="detail_caption"></span>
    </div>
    <div class="detail-wrap">
      <table class="three-line detail" id="detail-tbl"></table>
    </div>
    </details>
  </section>

  <!-- Footer. -->
  <footer class="foot">
    <span>wiek-bench · run_report.py --single</span>
    <span class="pg">— 1 —</span>
    <span id="ft-gen"></span>
  </footer>
</div>

<script id="report-messages" type="application/json">__REPORT_MESSAGES__</script>
<script id="payload" type="application/json">__PAYLOAD__</script>
<script>
/* Zero-dependency inline renderer. The test side is always empty in single mode. */
(function () {
  const I = JSON.parse(document.getElementById("report-messages").textContent);
  const PAYLOAD = JSON.parse(document.getElementById("payload").textContent);
  const M = PAYLOAD.meta, T = PAYLOAD.totals.base || {}, R = PAYLOAD.rows || [];
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s == null ? "" : s)
    .replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
  const tr = (key, vars) => {
    let text = I[key] || key;
    Object.entries(vars || {}).forEach(([name, value]) => {
      text = text.split("{" + name + "}").join(String(value));
    });
    return text;
  };
  const fS  = (v, d) => v == null ? "—" : Number(v).toFixed(d == null ? 1 : d);
  const fC  = (v, d) => v == null ? "—" : "$" + Number(v).toFixed(d == null ? 3 : d);
  const fmtClock = (s) => { if (s == null) return "—"; const m = Math.floor(s / 60), r = Math.round(s % 60); return m + "m " + String(r).padStart(2, "0") + "s"; };
  const fmtDur = (s) => s == null ? "—" : s >= 60 ? fmtClock(s) : fS(s) + "s";
  const fmtTok = (n) => n == null ? "—" : n >= 1e6 ? (n / 1e6).toFixed(2) + "M" : n >= 1e3 ? (n / 1e3).toFixed(1) + "k" : String(n);
  const fPct = (v) => v == null || !isFinite(v) ? "—" : (v * 100).toFixed(1) + "%";
  /* Normalize the boolean tasks.jsonl verdict to pass, fail, or null. */
  const vNorm = (v) => (v === true || v === "pass") ? "pass" : (v === false || v === "fail") ? "fail" : null;

  document.querySelectorAll("[data-i18n]").forEach((element) => {
    element.textContent = I[element.dataset.i18n] || "";
  });
  document.querySelectorAll("details.fold > summary h2").forEach((heading) => {
    heading.dataset.expandLabel = I.expand;
    heading.dataset.collapseLabel = I.collapse;
  });

  /* Tool-chain and command-distribution formatters. */
  const chainText = (chain, limit) => {
    limit = limit || 12;
    chain = chain || [];
    if (!chain.length) return "—";
    const head = chain.slice(0, limit).map(esc).join(' <span class="arrow">→</span> ');
    return chain.length > limit ? head + ' <span class="arrow">→</span> …' : head;
  };
  const cmdsText = (cmds, limit) => {
    limit = limit || 5;
    const ent = Object.entries(cmds || {}).sort((a, b) => b[1] - a[1]);
    if (!ent.length) return "—";
    const head = ent.slice(0, limit).map(([k, n]) => esc(k) + "×" + n).join(", ");
    return ent.length > limit ? head + ", …" : head;
  };

  /* Split failure_reason into rubric decisions at "; R<n>:". */
  const parseRubrics = (text) => {
    return String(text).split(/\s*[;；]\s*(?=R\d+\s*[:：])/).map((s) => {
      const m = s.match(/^\s*R(\d+)\s*[:：]\s*([\s\S]*)$/);
      return m ? { id: "R" + m[1], text: m[2].replace(/[；;。]\s*$/, "").trim() }
               : { id: "", text: s.trim() };
    }).filter((p) => p.text);
  };
  /* Build per-rubric judge-session links relative to each source run. */
  const judgeHref = (row, rid) =>
    "../" + (row.base && row.base.source_run ? row.base.source_run : (M.base_dirs || [])[0] || "") +
    "/judge_sessions_html/" + (row.base && row.base.task_id ? row.base.task_id : row.task_id) + "/" + rid + ".html";

  /* Render structured Odysseys rubrics as an accordion with separate judge-session
     links. Fall back to parsing failure_reason for older or non-Odysseys data. */
  const frBlock = (row) => {
    const b = row.base || {};
    const rr = b.rubric_results;
    if (rr && rr.length) {
      const failN = rr.filter((r) => !r.satisfied).length;
      const chips = rr.map((r) =>
        '<span class="rubric-tag ' + (r.satisfied ? "ghost-ok" : "ghost") + '">' + esc(r.id) + "</span>").join(" ");
      const body = rr.map((r) => {
        const ok = r.satisfied;
        const tag = r.id
          ? '<a class="rubric-tag ra-link' + (ok ? " ok" : "") + '" href="' + esc(judgeHref(row, r.id)) +
            '" target="_blank" rel="noopener" title="' + esc(I.open_rubric_session) +
            '" onclick="event.stopPropagation()">' + esc(r.id) + '<span class="ra-ext">↗</span></a>'
          : '<span class="rubric-tag">·</span>';
        return '<div class="acc-item"><div class="acc-head">' + tag +
          '<span class="acc-status ' + (ok ? "ok" : "fail") + '">' + (ok ? "✓ pass" : "✗ fail") + "</span>" +
          (r.confidence != null ? '<span class="acc-conf">conf ' + esc(r.confidence) + "/10</span>" : "") +
          '<span class="acc-peek">' + esc(r.requirement) + "</span>" +
          '<span class="acc-chev">▸</span></div>' +
          '<div class="acc-body">' +
          (r.requirement ? '<div class="ra-req"><b>requirement</b>' + esc(r.requirement) + "</div>" : "") +
          '<div class="ra-reason">' + esc(r.reasoning) + "</div></div></div>";
      }).join("");
      return '<details class="fr judge-only"><summary><span class="chev">▸</span>' +
        '<span class="fr-label">' + esc(I.rubric_audit) + "</span> " +
        esc(tr("audit_items", { count: rr.length })) +
        (failN ? esc(tr("audit_unmet", { count: failN })) : esc(I.audit_all_passed)) +
        " · " + chips +
        '</summary><div class="fr-body ra-acc">' + body + "</div></details>";
    }
    const rs = parseRubrics(b.failure_reason);
    const chips = rs.map((r) => r.id ? '<span class="rubric-tag ghost">' + esc(r.id) + "</span>" : "").filter(Boolean).join(" ");
    const body = rs.map((r) =>
      '<div class="fr-item"><span class="rubric-tag">' + esc(r.id || "·") + "</span><span>" + esc(r.text) + "</span></div>"
    ).join("");
    return '<details class="fr judge-only"><summary><span class="chev">▸</span>' +
      '<span class="fr-label">failure_reason</span>' +
      esc(tr("audit_unmet", { count: rs.length })) +
      (chips ? " · " + chips : "") + '</summary><div class="fr-body">' + body + "</div></details>";
  };

  /* Header and byline. */
  const stampMatch = String(M.base_run || "").match(/\d{8}T\d{6}Z/);
  $("hd-no").textContent = "TR-" + (stampMatch ? stampMatch[0].replace(/[TZ]/g, "-").replace(/-$/, "") : String(PAYLOAD.gen_at || "").replace(/\D/g, "").slice(0, 12));
  $("hd-title").textContent = (M.benchmark ? M.benchmark + " " : "") + I.report_title;
  $("hd-runid").textContent = "run_id  " + (M.base_run || "—");
  $("hd-byline").innerHTML =
    'benchmark <b>' + esc(M.benchmark || "—") + '</b> · provider <b>' + esc(M.provider || "—") + '</b> / <b>' + esc(M.model || "—") +
    '</b> · browser_tool <b>' + esc(M.browser_tool || "—") + '</b> · skill <b>' + esc(M.base_label) + '</b>' +
    " · " + esc(I.generated_at) + ' <b>' + esc(PAYLOAD.gen_at) + '</b>';

  /* Abstract. */
  const dropN = (M.base_dropped || []).length;
  const iters = M.iterations || [];
  const iterationClause = iters.length > 1
    ? tr("abstract_iterations", { count: iters.length })
    : "";
  const intro = tr("abstract_intro", {
    benchmark: esc(M.benchmark || "—"),
    provider: esc(M.provider || "—"),
    model: esc(M.model || "—"),
    label: esc(M.base_label),
    browser_tool: esc(M.browser_tool || "—"),
    task_count: M.paired_count != null ? M.paired_count : "—",
    iteration_clause: iterationClause,
    planned: M.planned_count != null ? M.planned_count : "—",
    kept: T.count || 0,
    dropped: dropN,
  });
  let poolSummary = I.abstract_empty;
  if (T.count) {
    const medianClause = T.duration_p50 != null
      ? tr("abstract_median", {
          duration_p50: fS(T.duration_p50),
          duration_p90: fS(T.duration_p90),
        })
      : "";
    let timingClause = "";
    if (T.llm_time_total != null) {
      const timingKey = T.think_time_total != null
        ? "abstract_timing_with_think"
        : "abstract_timing_without_think";
      timingClause = tr(timingKey, {
        think_share: fPct(T.think_time_total / T.duration_total),
        llm_share: fPct(T.llm_time_total / T.duration_total),
        env_share: fPct(T.env_time_total / T.duration_total),
      });
    }
    const costKey = T.cost_avg == null
      ? "abstract_cost_unavailable"
      : T.cost_is_estimate
        ? "abstract_cost_estimated"
        : "abstract_cost_measured";
    const costClause = tr(costKey, { cost_avg: fC(T.cost_avg) });
    const judgeClause = T.success_rate == null
      ? ""
      : tr("abstract_judge", {
          success_rate: (T.success_rate * 100).toFixed(1) + "%",
        });
    poolSummary = tr("abstract_metrics", {
      duration_avg: fS(T.duration_avg),
      median_clause: medianClause,
      duration_cv: fS(T.duration_cv, 2),
      timing_clause: timingClause,
      turns_avg: fS(T.turns_avg),
      tokens_avg: fmtTok(T.tokens_avg),
      tokens_total: fmtTok(T.tokens_total),
      cost_clause: costClause,
      tools: T.tools,
      tool_failures: T.tool_failures,
      judge_clause: judgeClause,
    });
  }
  $("ab-text").innerHTML = [intro, poolSummary, I.abstract_no_comparison].join(" ");

  /* Run metadata. */
  const metaPairs = [
    ["run_id", M.base_run],
    ["benchmark", M.benchmark || "—"],
    ["provider / model", (M.provider || "—") + " / " + (M.model || "—")],
    ["browser_tool", M.browser_tool || "—"],
    ["skill label", M.base_label],
    ["gen_at", PAYLOAD.gen_at],
    ["mode", M.mode],
    ["iterations", iters.length ? iters.join(", ") : "—"],
    [I.meta_base_task_count, (M.paired_count != null ? M.paired_count : "—") + " " +
      tr("meta_common", { count: M.common_count != null ? M.common_count : "—" })],
    ["planned / kept", (M.planned_count != null ? M.planned_count : "—") + " / " + (T.count || 0)],
    ["dropped", String(dropN)],
    ["concurrency", M.base_concurrency != null ? String(M.base_concurrency) : "—"],
    ["wall time", M.base_wall ? fmtClock(M.base_wall) : "—"],
    ["judge model", M.base_judge || "—"],
    ...(T.judge_avg_duration_per_rubric_s != null ? [["avg judge / rubric", fS(T.judge_avg_duration_per_rubric_s) + " s · n=" + T.judge_rubric_count + " rubrics · cumulative " + fS(T.judge_total_duration_s, 0) + " s"]] : []),
    ...(M.base_judge_wall_s != null ? [["judge wall time", fS(M.base_judge_wall_s, 0) + " s · " +
      (M.base_run_count === 1 ? I.latest_job : I.latest_jobs_sum) + " · ≈ " +
      fmtClock(M.base_judge_wall_s)]] : [])
  ];
  const half = Math.ceil(metaPairs.length / 2);
  $("meta-grid").innerHTML = [metaPairs.slice(0, half), metaPairs.slice(half)].map(col =>
    "<dl>" + col.map(([k, v]) => "<dt>" + esc(k) + "</dt><dd>" + esc(v) + "</dd>").join("") + "</dl>"
  ).join("");

  /* Expandable dropped-sample details. */
  if (dropN) {
    $("dropped-box").innerHTML =
      "<summary>" + esc(tr("dropped_summary", { count: dropN })) + "</summary>" +
      '<table class="three-line dropped-tbl"><thead><tr><th>task_id</th><th>source_run</th><th>reason</th></tr></thead><tbody>' +
      (M.base_dropped || []).map(d =>
        '<tr><td>' + esc(d.task_id) + '</td><td class="dim small">' + esc(d.source_run) + '</td>' +
        '<td style="color:var(--accent)">' + esc(d.reason) + "</td></tr>").join("") +
      "</tbody></table>";
  } else {
    $("dropped-box").style.display = "none";
  }

  /* Metric band in seconds, with total duration repeated in clock format. */
  $("t1-n").textContent = T.count || 0;
  const stats = T.count ? [
    { k: "avg duration",    v: fS(T.duration_avg), u: "s", sub: tr("sample_mean", { count: T.count }) },
    { k: "p50 duration",    v: fS(T.duration_p50), u: "s", sub: I.median },
    { k: "p90 duration",    v: fS(T.duration_p90), u: "s", sub: I.percentile_90 },
    { k: "duration spread", v: "σ " + fS(T.duration_std), u: "", sub: "CV " + fS(T.duration_cv, 3) },
    { k: "total duration",  v: fS(T.duration_total, 0), u: "s", sub: "≈ " + fmtClock(T.duration_total) },
    { k: "avg turns",       v: fS(T.turns_avg), u: "", sub: "total " + (T.turns != null ? T.turns : "—") },
    ...(T.ttft_avg != null ? [{ k: "avg TTFT", v: fS(T.ttft_avg), u: "s", sub: "provider native · p90 " + fS(T.ttft_p90) + " s" }] : []),
    { k: "total tokens",    v: fmtTok(T.tokens_total), u: "", sub: "in " + fmtTok(T.tokens_in) + " · out " + fmtTok(T.tokens_out) + " · avg " + fmtTok(T.tokens_avg) + (T.tokens_reasoning != null ? " · reasoning " + (T.tokens_reasoning_is_estimate ? "≈" : "") + fmtTok(T.tokens_reasoning) + (T.tokens_reasoning_is_estimate ? I.reasoning_estimated_suffix : "") : "") },
    { k: T.cost_is_estimate ? "avg cost · est." : "avg cost", v: fC(T.cost_avg), u: "", sub: tr("priced_samples", { priced: T.cost_count, total: T.count }), accent: true },
    { k: "cost spread",     v: "σ " + fC(T.cost_std), u: "", sub: "CV " + fS(T.cost_cv, 3) },
    { k: T.cost_is_estimate ? "total cost · est." : "total cost", v: fC(T.cost_total, 2), u: "", sub: T.cost_is_estimate ? "API-equivalent" : tr("sample_total", { count: T.cost_count }), accent: true },
    { k: "tool calls",      v: String(T.tools), u: "", sub: "failures " + T.tool_failures + " · avg " + fS(T.tools_avg) },
  ] : [];
  if (T.success_rate != null) {
    stats.push({ k: "success rate", v: (T.success_rate * 100).toFixed(1), u: "%", sub: "judge: " + (M.base_judge || "—"), accent: true, judge: true });
  }
  $("stat-band").innerHTML = stats.map(s =>
    '<div class="stat' + (s.accent ? " accent" : "") + (s.judge ? " judge-only" : "") + '">' +
    '<span class="k">' + esc(s.k) + '</span>' +
    '<span class="v">' + esc(s.v) + (s.u ? "<small>" + s.u + "</small>" : "") + '</span>' +
    '<span class="sub">' + esc(s.sub) + "</span></div>").join("");

  /* Timing breakdown. Hide the block or rows when their source metrics are absent. */
  const SEG_BG = {
    ink:   "var(--ink)",
    soft:  "var(--ink-soft)",
    red:   "var(--accent)",
    hatch: "repeating-linear-gradient(45deg, var(--ink) 0 2px, transparent 2px 4px)",
  };
  if (T.llm_time_avg == null) {
    $("latency-block").style.display = "none";
  } else {
    const latRows = [
      { name: I.latency_duration, avg: T.duration_avg, p50: T.duration_p50, p90: T.duration_p90, total: T.duration_total, seg: null },
      { name: I.latency_think, avg: T.think_time_avg, p50: T.think_time_p50, p90: T.think_time_p90, total: T.think_time_total, seg: "ink" },
      { name: T.think_time_avg != null ? I.latency_llm_without_think : I.latency_llm_with_think, avg: T.llm_time_avg, p50: T.llm_time_p50, p90: T.llm_time_p90, total: T.llm_time_total, seg: "soft" },
      { name: I.latency_env, avg: T.env_time_avg, p50: T.env_time_p50, p90: T.env_time_p90, total: T.env_time_total, seg: "red" },
      { name: I.latency_overhead, avg: T.overhead_avg, p50: T.overhead_p50, p90: T.overhead_p90, total: T.overhead_total, seg: "hatch" },
    ].filter(r => r.seg === null || r.avg != null);
    $("latency-tbl").innerHTML =
      "<thead><tr><th>" + esc(I.latency_component) + "</th><th>avg / s</th><th>p50 / s</th><th>p90 / s</th><th>total / s</th><th>share</th></tr></thead><tbody>" +
      latRows.map((r, i) => {
        const share = r.total / T.duration_total;
        return "<tr><td>" + esc(r.name) + "</td><td>" + fS(r.avg) + "</td><td>" + fS(r.p50) + "</td><td>" + fS(r.p90) +
          "</td><td>" + fS(r.total, 1) + "</td><td" + (i === 0 ? " class='dim'" : "") + ">" + fPct(share) + "</td></tr>";
      }).join("") + "</tbody>";
    $("latency-stack").innerHTML = latRows.slice(1).map(r =>
      '<div class="stack-seg" style="width:' + (r.total / T.duration_total * 100).toFixed(1) + '%;background:' + SEG_BG[r.seg] +
      '" title="' + esc(r.name) + " " + fPct(r.total / T.duration_total) + '"></div>').join("");
    $("latency-legend").innerHTML = latRows.slice(1).map(r =>
      '<span class="sw" style="background:' + SEG_BG[r.seg] + '"></span>' + esc(r.name) + " " + fPct(r.total / T.duration_total)).join("");
  }

  /* Render per-iteration means only when at least two iterations exist. */
  const iterKeys = Object.keys(PAYLOAD.iter || {}).sort((a, b) => +a - +b);
  if (iterKeys.length < 2) {
    $("sec-iter").style.display = "none";
  } else {
    const cols = [
      { title: "duration_avg / s", get: (a) => a.duration_avg, fmt: (v) => fS(v) + " s", cls: "" },
      ...(T.cost_count ? [{ title: T.cost_is_estimate ? "cost_avg est. / $" : "cost_avg / $", get: (a) => a.cost_avg, fmt: (v) => fC(v), cls: "red" }] : []),
      { title: "tools_avg",        get: (a) => a.tools_avg,    fmt: (v) => fS(v),        cls: "hatch" },
    ];
    $("iter-cols").innerHTML = cols.map(c => {
      const max = Math.max(...iterKeys.map(k => c.get(PAYLOAD.iter[k].base) || 0)) || 1;
      return '<div><div class="bar-group-title">' + esc(c.title) + "</div>" +
        iterKeys.map(k => {
          const a = PAYLOAD.iter[k].base, v = c.get(a) || 0;
          return '<div class="bar-row" style="grid-template-columns:88px 1fr 70px">' +
            '<div class="lbl">iter ' + esc(k) + ' <span class="it">n=' + a.count + "</span></div>" +
            '<div class="bar-track"><div class="bar-fill ' + c.cls + '" style="width:' + (v / max * 100).toFixed(1) + '%"></div></div>' +
            '<div class="val">' + c.fmt(v) + "</div></div>";
        }).join("") + "</div>";
    }).join("");
  }

  /* Per-base-task means. */
  const pbKeys = Object.keys(PAYLOAD.per_base || {});
  if (!pbKeys.length) {
    $("sec-perbase").style.display = "none";
  } else {
    const pbMax = {
      d: Math.max(...pbKeys.map(k => PAYLOAD.per_base[k].base.duration_avg || 0)) || 1,
      c: Math.max(...pbKeys.map(k => PAYLOAD.per_base[k].base.cost_avg || 0)) || 1,
      t: Math.max(...pbKeys.map(k => PAYLOAD.per_base[k].base.tools_avg || 0)) || 1,
    };
    const bar = (v, max, cls) =>
      '<div class="bar-track" style="height:6px;min-width:64px"><div class="bar-fill ' + cls + '" style="width:' + ((v || 0) / max * 100).toFixed(1) + '%"></div></div>';
    $("perbase-tbl").innerHTML =
      "<thead><tr><th>base_task_id</th><th>n</th>" +
      '<th style="text-align:left;width:14%"></th><th>duration_avg</th>' +
      '<th style="text-align:left;width:14%"></th><th>cost_avg</th>' +
      '<th style="text-align:left;width:14%"></th><th>tools_avg</th></tr></thead><tbody>' +
      pbKeys.map(k => {
        const b = PAYLOAD.per_base[k].base;
        return "<tr><td>" + esc(k) + '</td><td class="dim">' + PAYLOAD.per_base[k].count + "</td>" +
          '<td style="text-align:left">' + bar(b.duration_avg, pbMax.d, "") + "</td><td>" + fS(b.duration_avg) + " s</td>" +
          '<td style="text-align:left">' + bar(b.cost_avg, pbMax.c, "red") + "</td><td>" + fC(b.cost_avg) + "</td>" +
          '<td style="text-align:left">' + bar(b.tools_avg, pbMax.t, "hatch") + "</td><td>" + fS(b.tools_avg) + "</td></tr>";
      }).join("") + "</tbody>";
  }

  /* Individual samples use fmtClock for duration. */
  const sessionHref = (row) =>
    "../" + (row.base && row.base.source_run ? row.base.source_run : (M.base_dirs || [])[0] || "") +
    "/sessions_html/" + (row.base && row.base.task_id ? row.base.task_id : row.task_id) + ".html";
  /* Build trajectory-gallery links relative to each source run and render the
     badge only when the sample has screenshot evidence. */
  const shotsHref = (row) =>
    "../" + (row.base && row.base.source_run ? row.base.source_run : (M.base_dirs || [])[0] || "") +
    "/screenshots_html/" + (row.base && row.base.task_id ? row.base.task_id : row.task_id) + ".html";
  const FT_LIMIT = 320;
  $("samples").innerHTML = R.map((row, i) => {
    const b = row.base || {};
    const ftext = String(b.final_text || "");
    const long = ftext.length > FT_LIMIT;
    const head = esc(ftext.slice(0, FT_LIMIT));
    const tail = long ? esc(ftext.slice(FT_LIMIT)) : "";
    const verdict = vNorm(b.verdict);
    let badges = "";
    /* A CAPTCHA-intercepted sample never reached a judge, so it carries no verdict —
       lead with the amber badge that explains why; the agent's own description of the
       wall rides along as the tooltip. */
    if (b.captcha_blocked) {
      badges += '<span class="badge captcha" title="' + esc(b.captcha_detail || "") +
        '">⚠ captcha_blocked</span>';
    }
    if (verdict) {
      badges += '<span class="badge judge-only ' + (verdict === "pass" ? "pass" : "fail") + '">' +
        verdict + (b.score != null ? " · score " + b.score : "") + "</span>";
    }
    if (b.reached_captcha) badges += '<span class="badge flag">reached_captcha</span>';
    if (b.impossible_task) badges += '<span class="badge flag">impossible_task</span>';
    return '<div class="sample">' +
      '<div class="sample-head">' +
        '<a class="tid" href="' + esc(sessionHref(row)) + '">' + esc(row.task_id) + "</a>" +
        (b.has_screenshots ? ' <a class="shot-badge" href="' + esc(shotsHref(row)) +
          '" target="_blank" rel="noopener" title="' + esc(I.screenshot_gallery_title) + '">📷</a>' : "") +
        '<span class="tag">iter ' + row.iter + "</span>" +
        (row.category ? '<span class="tag">' + esc(row.category) + "</span>" : "") + badges +
        '<span class="sample-metrics"><b>' + fmtClock(b.duration) + '</b><span class="sep">|</span>' +
          '<b title="' + esc(b.cost_source || "") + '">' + (b.cost_is_estimate ? "≈" : "") + fC(b.cost) + '</b><span class="sep">|</span>' +
          "<b>" + (b.tools != null ? b.tools : "—") + "</b> tools" + (b.tool_failures ? ' <span style="color:var(--accent)">(' + b.tool_failures + " fail)</span>" : "") +
        "</span>" +
      "</div>" +
      (b.llm_time != null
        ? '<div class="kv-line"><span class="k">usage</span><span class="chain">' +
          (b.think_time != null ? 'think <b>' + fmtDur(b.think_time) + '</b> (' + fPct(b.think_time / b.duration) + ') · ' : '') +
          'llm <b>' + fmtDur(b.llm_time) +
          '</b> (' + fPct(b.llm_time / b.duration) + ') · env <b>' + fmtDur(b.env_time) +
          '</b> (' + fPct(b.env_time / b.duration) + ') · overhead <b>' + fmtDur(Math.max(0, b.duration - (b.think_time || 0) - b.llm_time - b.env_time)) + '</b>' +
          (b.time_to_first_token != null ? ' ｜ TTFT <b>' + fmtDur(b.time_to_first_token) + '</b>' : '') +
          ' ｜ turns <b>' + (b.turns != null ? b.turns : "—") + '</b> ｜ tok in <b>' + fmtTok(b.tokens_in) + '</b> / out <b>' + fmtTok(b.tokens_out) + '</b>' +
          "</span></div>"
        : "") +
      '<div class="kv-line"><span class="k">chain</span><span class="chain">' + chainText(b.chain) + "</span></div>" +
      '<div class="kv-line"><span class="k">cmds</span><span class="chain">' + cmdsText(b.cmds) + "</span></div>" +
      '<div class="kv-line"><span class="k">final</span><span class="final">' + head +
        (long
          ? '<span class="ft-more" id="ftm-' + i + '" style="display:none">' + tail + "</span>" +
            '<span class="ft-ell" id="fte-' + i + '">…</span>' +
            '<button class="expand-btn" data-i="' + i + '">' + esc(I.expand_full) + "</button>"
          : "") +
      "</span></div>" +
      ((b.rubric_results && b.rubric_results.length) || b.failure_reason
        ? frBlock(row) : "") +
    "</div>";
  }).join("");

  /* Toggle rubric reasoning from the header row without intercepting session links. */
  document.querySelectorAll(".acc-head").forEach(h => {
    h.addEventListener("click", () => h.parentElement.classList.toggle("open"));
  });

  document.querySelectorAll(".expand-btn").forEach(btn => {
    btn.addEventListener("click", function () {
      const i = this.dataset.i, more = $("ftm-" + i), ell = $("fte-" + i);
      const open = more.style.display !== "none";
      more.style.display = open ? "none" : "inline";
      ell.style.display = open ? "inline" : "none";
      this.textContent = open ? I.expand_full : I.collapse;
    });
  });

  /* Numeric detail table retains seconds for downstream analysis. */
  $("detail-tbl").innerHTML =
    "<thead><tr><th>#</th><th>task_id</th><th>iter</th><th>category</th>" +
    "<th>duration_s</th><th>think_s</th><th>llm_s</th><th>env_s</th><th>ttft_s</th><th>turns</th><th>tok_in</th><th>tok_out</th>" +
    "<th>cost_usd</th><th>tools</th><th>tool_failures</th>" +
    '<th class="judge-only">score</th><th class="judge-only">verdict</th></tr></thead><tbody>' +
    R.map((row, i) => {
      const b = row.base || {};
      const verdict = vNorm(b.verdict);
      // Draw a hairline only at base-task group boundaries.
      const sep = i + 1 < R.length && R[i + 1].base_task_id !== row.base_task_id;
      return "<tr" + (sep ? " class='task-sep'" : "") + "><td class='dim'>" + (i + 1) + "</td><td style='text-align:left'>" + esc(row.task_id) + "</td>" +
        "<td>" + row.iter + "</td><td class='dim'>" + esc(row.category) + "</td>" +
        "<td>" + (b.duration != null ? Number(b.duration).toFixed(1) : "—") + "</td>" +
        "<td>" + (b.think_time != null ? Number(b.think_time).toFixed(1) : "—") + "</td>" +
        "<td>" + (b.llm_time != null ? Number(b.llm_time).toFixed(1) : "—") + "</td>" +
        "<td>" + (b.env_time != null ? Number(b.env_time).toFixed(1) : "—") + "</td>" +
        "<td>" + (b.time_to_first_token != null ? Number(b.time_to_first_token).toFixed(1) : "—") + "</td>" +
        "<td>" + (b.turns != null ? b.turns : "—") + "</td>" +
        "<td>" + (b.tokens_in != null ? b.tokens_in : "—") + "</td>" +
        "<td>" + (b.tokens_out != null ? b.tokens_out : "—") + "</td>" +
        '<td title="' + esc(b.cost_source || "") + '">' + (b.cost != null ? (b.cost_is_estimate ? "≈" : "") + Number(b.cost).toFixed(3) : "—") + "</td>" +
        "<td>" + (b.tools != null ? b.tools : "—") + "</td><td" + (b.tool_failures ? ' style="color:var(--accent)"' : " class='dim'") + ">" + (b.tool_failures || 0) + "</td>" +
        '<td class="judge-only">' + (b.score != null ? b.score : "—") + "</td>" +
        '<td class="judge-only"' + (verdict === "fail" ? ' style="color:var(--accent)"' : "") + ">" + esc(verdict || "—") + "</td></tr>";
    }).join("") + "</tbody>";

  /* Dataset-specific renderers are injected here and share the helpers above. */
__MODULE_JS__

  /* Footer. */
  $("ft-gen").textContent = "generated " + PAYLOAD.gen_at;
})();
</script>
</body>
</html>
"""
