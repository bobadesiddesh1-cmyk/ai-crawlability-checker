/**
 * content/overlay.js
 *
 * The on-page highlight layer: red boxes over every block that is INVISIBLE to
 * the selected bot, subtle green outlines over the blocks that are visible,
 * and a compact draggable panel for switching between bots.
 *
 * Classic script, isolated world. Attaches to `self.AICL.overlay`.
 *
 * ---------------------------------------------------------------------------
 * THE HARD CONSTRAINT: THE PAGE IS NEVER MODIFIED
 * ---------------------------------------------------------------------------
 * Not one attribute, class, style or node on the real page is touched. Adding
 * an outline class to a live element can fire MutationObservers, trigger CSS
 * transitions, shift layout, and make frameworks re-render — on an SEO audit
 * tool that is unacceptable, because the thing being measured would change
 * under measurement.
 *
 * Instead: ONE `position: fixed` host element is appended to
 * `document.documentElement`, carrying a shadow root. Inside it, absolutely
 * positioned boxes are drawn over each block's `getBoundingClientRect()`.
 * Remove the host and the page is byte-for-byte what it was.
 *
 * The highlight layer is `pointer-events: none` throughout, so clicks, hovers
 * and text selection all pass straight through to the page. Only the panel
 * re-enables pointer events, on itself.
 */

(function () {
  'use strict';

  const AICL = (self.AICL = self.AICL || {});

  const HOST_ID = '__aicl-overlay-host__';

  /** Live overlay state. Null when the overlay is not shown. */
  let live = null;

  /* ----------------------------------------------------------------------- */
  /* Styles                                                                   */
  /* ----------------------------------------------------------------------- */

  const STYLES = `
    :host { all: initial; }
    * { box-sizing: border-box; }

    .layer {
      position: absolute;
      inset: 0;
      pointer-events: none;
    }

    .box {
      position: absolute;
      pointer-events: none;
      border-radius: 3px;
      transition: none;
    }
    .box.invisible {
      border: 2px solid rgba(233, 62, 18, 0.92);
      background: rgba(233, 62, 18, 0.15);
      box-shadow: 0 0 0 1px rgba(255, 255, 255, 0.35) inset;
    }
    .box.visible {
      border: 1px solid rgba(31, 107, 69, 0.5);
      background: rgba(31, 107, 69, 0.06);
    }

    .tag {
      position: absolute;
      /* Fully above the box border, sitting in the inter-block margin gap.
         Straddling the border clipped the ascenders on the block's first line. */
      top: -15px;
      left: 6px;
      font: 600 10px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
      letter-spacing: .02em;
      color: #fff;
      background: #e93e12;
      padding: 0 5px;
      border-radius: 3px;
      white-space: nowrap;
      pointer-events: none;
    }

    .panel {
      position: absolute;
      top: 16px;
      right: 16px;
      width: 300px;
      max-height: calc(100vh - 32px);
      overflow: auto;
      pointer-events: auto;
      background: #fffefd;
      color: #1a1512;
      border: 1px solid #ded5cd;
      border-radius: 10px;
      box-shadow: 0 10px 30px rgba(0, 0, 0, .22);
      font: 13px/1.45 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
    }

    .panel-head {
      display: flex;
      align-items: center;
      gap: 8px;
      padding: 10px 12px;
      border-bottom: 1px solid #e8e1db;
      cursor: grab;
      user-select: none;
    }
    .panel-head:active { cursor: grabbing; }
    .panel-title { font-weight: 650; font-size: 12.5px; flex: 1; }
    .panel-title small { display: block; font-weight: 400; color: #6b615a; font-size: 11px; }

    .close {
      all: unset;
      cursor: pointer;
      width: 22px; height: 22px;
      display: grid; place-items: center;
      border-radius: 5px;
      color: #6b615a;
      font-size: 15px;
      line-height: 1;
    }
    .close:hover { background: #f5f0ec; color: #1a1512; }

    .tabs { display: flex; flex-wrap: wrap; gap: 5px; padding: 10px 12px; }

    .tab {
      all: unset;
      cursor: pointer;
      display: inline-flex;
      align-items: center;
      gap: 5px;
      padding: 4px 8px;
      border: 1px solid #ded5cd;
      border-radius: 999px;
      font-size: 11.5px;
      white-space: nowrap;
    }
    .tab:hover { background: #faf7f4; }
    .tab[aria-selected="true"] {
      background: #1a1512;
      border-color: #1a1512;
      color: #fffefd;
    }
    .tab .chip {
      font-weight: 700;
      font-size: 10.5px;
      padding: 0 4px;
      border-radius: 4px;
      background: rgba(0,0,0,.08);
    }
    .tab[aria-selected="true"] .chip { background: rgba(255,255,255,.2); }
    .chip.red   { background: #fde7e0; color: #b4300e; }
    .chip.amber { background: #fbf0d8; color: #8a5a00; }
    .chip.green { background: #ddf2e6; color: #1f6b45; }
    .chip.none  { background: #efe8e2; color: #4a423c; }
    .tab[aria-selected="true"] .chip.red,
    .tab[aria-selected="true"] .chip.amber,
    .tab[aria-selected="true"] .chip.green,
    .tab[aria-selected="true"] .chip.none { background: rgba(255,255,255,.22); color: #fff; }

    .body { padding: 0 12px 12px; }

    .verdict {
      border-radius: 6px; padding: 8px 9px; margin-bottom: 8px;
      font-size: 11.5px; font-weight: 600; line-height: 1.4;
    }
    .verdict.good { background: #ddf2e6; color: #1f6b45; }
    .verdict.warn { background: #fbf0d8; color: #8a5a00; }
    .verdict.critical { background: #fde7e0; color: #b4300e; }

    .stat {
      display: flex; justify-content: space-between; gap: 10px;
      padding: 4px 0; border-top: 1px dashed #e8e1db; font-size: 12px;
    }
    .stat:first-child { border-top: 0; }
    .stat b { font-variant-numeric: tabular-nums; }

    .legend { display: flex; gap: 12px; padding: 8px 0 2px; font-size: 11.5px; color: #6b615a; }
    .swatch { display: inline-block; width: 10px; height: 10px; border-radius: 2px; margin-right: 4px; vertical-align: -1px; }
    .swatch.red { background: rgba(233,62,18,.35); border: 1px solid #e93e12; }
    .swatch.green { background: rgba(31,107,69,.15); border: 1px solid rgba(31,107,69,.6); }

    .msg { font-size: 11.5px; color: #6b615a; padding-top: 6px; }
    .msg.warn { color: #8a5a00; }

    @media (prefers-color-scheme: dark) {
      .panel { background: #1c1714; color: #efe9e4; border-color: #362d28; }
      .panel-head { border-bottom-color: #2a231f; }
      .panel-title small { color: #9c9089; }
      .close { color: #9c9089; }
      .close:hover { background: #2a231f; color: #fffefd; }
      .tab { border-color: #362d28; }
      .tab:hover { background: #241d19; }
      .tab[aria-selected="true"] { background: #efe9e4; border-color: #efe9e4; color: #14100e; }
      .tab[aria-selected="true"] .chip { background: rgba(0,0,0,.12); color: #14100e; }
      .tab[aria-selected="true"] .chip.red,
      .tab[aria-selected="true"] .chip.amber,
      .tab[aria-selected="true"] .chip.green,
      .tab[aria-selected="true"] .chip.none { background: rgba(0,0,0,.12); color: #14100e; }
      .chip.red   { background: #5c1a08; color: #ffb4a0; }
      .chip.amber { background: #4a3208; color: #f2ce7a; }
      .chip.green { background: #10402a; color: #9be0bc; }
      .chip.none  { background: #2a231f; color: #efe9e4; }
      .stat { border-top-color: #2a231f; }
      .legend, .msg { color: #9c9089; }
      .verdict.good { background: #10402a; color: #9be0bc; }
      .verdict.warn { background: #4a3208; color: #f2ce7a; }
      .verdict.critical { background: #5c1a08; color: #ffb4a0; }
    }
  `;

  /* ----------------------------------------------------------------------- */
  /* Construction                                                             */
  /* ----------------------------------------------------------------------- */

  function buildHost() {
    const host = document.createElement('div');
    host.id = HOST_ID;
    // Inline styles rather than a class, so no page stylesheet can reach in and
    // reposition or hide the overlay.
    host.setAttribute(
      'style',
      [
        'position:fixed',
        'inset:0',
        'width:100%',
        'height:100%',
        'margin:0',
        'padding:0',
        'border:0',
        'pointer-events:none',
        'z-index:2147483647',
        'contain:layout style'
      ].join(';')
    );

    const shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = STYLES;

    const layer = document.createElement('div');
    layer.className = 'layer';

    const panel = document.createElement('div');
    panel.className = 'panel';

    shadow.append(style, layer, panel);
    // documentElement, not body: some frameworks replace <body> wholesale on
    // route change, which would take the overlay with it.
    document.documentElement.appendChild(host);

    return { host, shadow, layer, panel };
  }

  /* ----------------------------------------------------------------------- */
  /* Rendering                                                                */
  /* ----------------------------------------------------------------------- */

  /**
   * Redraw the boxes for the currently selected bot.
   *
   * Only blocks intersecting the viewport (plus a small margin) get a box.
   * Drawing every block on a long page is thousands of nodes for no benefit,
   * since the boxes are viewport-positioned and get recomputed on scroll anyway.
   */
  function renderBoxes() {
    if (!live) return;

    const { layer, elements, perBot, currentBotId } = live;
    const entry = perBot[currentBotId];
    layer.textContent = '';
    if (!entry) return;

    const invisible = entry.invisibleSet;
    const visible = entry.visibleSet;

    const margin = 400;
    const vh = window.innerHeight;
    const vw = window.innerWidth;
    const frag = document.createDocumentFragment();

    for (let i = 0; i < elements.length; i += 1) {
      const isInvisible = invisible.has(i);
      const isVisible = visible.has(i);
      if (!isInvisible && !isVisible) continue;

      const el = elements[i];
      if (!el || !el.isConnected) continue;

      const r = el.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      if (r.bottom < -margin || r.top > vh + margin) continue;
      if (r.right < -margin || r.left > vw + margin) continue;

      const box = document.createElement('div');
      box.className = 'box ' + (isInvisible ? 'invisible' : 'visible');
      box.style.left = `${r.left}px`;
      box.style.top = `${r.top}px`;
      box.style.width = `${r.width}px`;
      box.style.height = `${r.height}px`;

      if (isInvisible && r.height >= 18 && r.width >= 90) {
        const tag = document.createElement('span');
        tag.className = 'tag';
        tag.textContent = 'invisible to ' + (entry.label || currentBotId);
        box.appendChild(tag);
      }

      frag.appendChild(box);
    }

    layer.appendChild(frag);
  }

  /** Rebuild the panel contents for the current selection. */
  function renderPanel() {
    if (!live) return;
    const { panel, perBot, currentBotId, order } = live;
    panel.textContent = '';

    /* Header ------------------------------------------------------------- */
    const head = document.createElement('div');
    head.className = 'panel-head';

    const title = document.createElement('div');
    title.className = 'panel-title';
    title.textContent = 'AI Crawlability Lens';
    const sub = document.createElement('small');
    sub.textContent = 'Red = invisible to this bot';
    title.appendChild(sub);

    const close = document.createElement('button');
    close.className = 'close';
    close.type = 'button';
    close.title = 'Dismiss overlay';
    close.setAttribute('aria-label', 'Dismiss overlay');
    close.textContent = '✕';
    close.addEventListener('click', hide);

    head.append(title, close);
    makeDraggable(head, panel);

    /* Tabs --------------------------------------------------------------- */
    const tabs = document.createElement('div');
    tabs.className = 'tabs';
    tabs.setAttribute('role', 'tablist');

    for (const botId of order) {
      const entry = perBot[botId];
      if (!entry) continue;

      const tab = document.createElement('button');
      tab.className = 'tab';
      tab.type = 'button';
      tab.setAttribute('role', 'tab');
      tab.setAttribute('aria-selected', String(botId === currentBotId));
      tab.appendChild(document.createTextNode(entry.label));

      const chip = document.createElement('span');
      chip.className = 'chip ' + entry.band;
      chip.textContent = entry.score === null || entry.score === undefined ? 'n/a' : String(entry.score);
      tab.appendChild(chip);

      tab.addEventListener('click', () => {
        live.currentBotId = botId;
        renderPanel();
        renderBoxes();
      });

      tabs.appendChild(tab);
    }

    /* Body --------------------------------------------------------------- */
    const body = document.createElement('div');
    body.className = 'body';
    const entry = perBot[currentBotId];

    if (entry) {
      // The answer first — the numbers below it are the evidence.
      if (entry.verdictHeadline) {
        const v = document.createElement('div');
        v.className = 'verdict ' + (entry.verdictSeverity || 'warn');
        v.textContent = entry.verdictHeadline;
        body.appendChild(v);
      }
      body.appendChild(stat('Visibility Score', entry.score === null ? 'n/a' : `${entry.score}/100`));
      body.appendChild(stat('Blocks invisible', `${entry.invisibleSet.size} of ${entry.totalBlocks}`));
      body.appendChild(stat('Headings invisible', `${entry.invisibleHeadings} of ${entry.totalHeadings}`));
      body.appendChild(stat('Fetch status', entry.statusLabel));

      const legend = document.createElement('div');
      legend.className = 'legend';
      legend.innerHTML =
        '<span><i class="swatch red"></i>Invisible</span><span><i class="swatch green"></i>Visible</span>';
      body.appendChild(legend);

    }

    const note = document.createElement('div');
    note.className = 'msg';
    note.textContent = 'This overlay draws over the page. It never modifies it.';
    body.appendChild(note);

    panel.append(head, tabs, body);
  }

  /**
   * @param {string} label
   * @param {string} value
   */
  function stat(label, value) {
    const row = document.createElement('div');
    row.className = 'stat';
    const l = document.createElement('span');
    l.textContent = label;
    const v = document.createElement('b');
    v.textContent = value;
    row.append(l, v);
    return row;
  }

  /**
   * Drag the panel by its header. Positions stay in the shadow root; the page
   * is untouched.
   *
   * @param {HTMLElement} handle
   * @param {HTMLElement} target
   */
  function makeDraggable(handle, target) {
    let startX = 0;
    let startY = 0;
    let originLeft = 0;
    let originTop = 0;
    let dragging = false;

    handle.addEventListener('pointerdown', (ev) => {
      if (ev.target && ev.target.classList && ev.target.classList.contains('close')) return;
      dragging = true;
      const r = target.getBoundingClientRect();
      originLeft = r.left;
      originTop = r.top;
      startX = ev.clientX;
      startY = ev.clientY;
      target.style.left = `${originLeft}px`;
      target.style.top = `${originTop}px`;
      target.style.right = 'auto';
      handle.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });

    handle.addEventListener('pointermove', (ev) => {
      if (!dragging) return;
      const nextLeft = Math.max(0, Math.min(window.innerWidth - 60, originLeft + (ev.clientX - startX)));
      const nextTop = Math.max(0, Math.min(window.innerHeight - 40, originTop + (ev.clientY - startY)));
      target.style.left = `${nextLeft}px`;
      target.style.top = `${nextTop}px`;
    });

    const end = (ev) => {
      if (!dragging) return;
      dragging = false;
      try {
        handle.releasePointerCapture(ev.pointerId);
      } catch {
        /* pointer already released */
      }
    };
    handle.addEventListener('pointerup', end);
    handle.addEventListener('pointercancel', end);
  }

  /* ----------------------------------------------------------------------- */
  /* Reprojection                                                             */
  /* ----------------------------------------------------------------------- */

  function scheduleReproject() {
    if (!live || live.rafId !== 0) return;
    live.rafId = requestAnimationFrame(() => {
      if (!live) return;
      live.rafId = 0;
      renderBoxes();
    });
  }

  /* ----------------------------------------------------------------------- */
  /* Public API                                                               */
  /* ----------------------------------------------------------------------- */

  /**
   * Show (or re-target) the overlay.
   *
   * @param {{
   *   botId: string,
   *   order: string[],
   *   perBot: Record<string, {
   *     label: string, score: number|null, band: string,
   *     invisibleIndices: number[], visibleIndices: number[],
   *     totalBlocks: number, invisibleHeadings: number, totalHeadings: number,
   *     status: string, statusLabel: string, statusDetail?: string,
   *     robotsBlocked: boolean
   *   }>
   * }} data
   */
  function show(data) {
    const elements = (AICL.state && AICL.state.elements) || [];
    if (!elements.length) {
      return { ok: false, error: 'No captured blocks to highlight. Run a check first.' };
    }

    if (!live) {
      const built = buildHost();
      live = {
        ...built,
        elements,
        perBot: {},
        order: [],
        currentBotId: data.botId,
        rafId: 0,
        onScroll: null,
        onResize: null,
        resizeObserver: null
      };

      live.onScroll = () => scheduleReproject();
      live.onResize = () => scheduleReproject();
      // capture:true so scrolling inside any nested scroll container also
      // re-projects — inner scrollers move blocks without firing on window.
      window.addEventListener('scroll', live.onScroll, { passive: true, capture: true });
      window.addEventListener('resize', live.onResize, { passive: true });

      if (typeof ResizeObserver !== 'undefined') {
        live.resizeObserver = new ResizeObserver(() => scheduleReproject());
        live.resizeObserver.observe(document.documentElement);
      }
    }

    live.elements = elements;
    live.order = data.order.slice();
    live.currentBotId = data.botId;
    live.perBot = {};

    for (const botId of Object.keys(data.perBot)) {
      const e = data.perBot[botId];
      live.perBot[botId] = {
        ...e,
        invisibleSet: new Set(e.invisibleIndices || []),
        visibleSet: new Set(e.visibleIndices || [])
      };
    }

    renderPanel();
    renderBoxes();
    return { ok: true };
  }

  /** Remove the overlay entirely and restore the page to its exact prior state. */
  function hide() {
    if (!live) return { ok: true };

    if (live.rafId) cancelAnimationFrame(live.rafId);
    if (live.onScroll) window.removeEventListener('scroll', live.onScroll, { capture: true });
    if (live.onResize) window.removeEventListener('resize', live.onResize);
    if (live.resizeObserver) live.resizeObserver.disconnect();
    if (live.host && live.host.parentNode) live.host.parentNode.removeChild(live.host);

    live = null;
    return { ok: true };
  }

  /** @returns {boolean} */
  function isVisible() {
    return live !== null;
  }

  /** Switch bots without rebuilding the host. */
  function selectBot(botId) {
    if (!live || !live.perBot[botId]) return { ok: false };
    live.currentBotId = botId;
    renderPanel();
    renderBoxes();
    return { ok: true };
  }

  AICL.overlay = { show, hide, isVisible, selectBot, HOST_ID };
})();
