// UWorld2Anki — content script v5.4
// Finds "Question Id: XXXX" in UWorld's header, injects an "Open in Anki" button,
// and shows the matching Anki card count inline.
//
// Injection strategy (in priority order):
//   1. INLINE  — if UWorld has a separate child element containing just the bare
//                number (its "value box"), the button is inserted INSIDE that element.
//                The button sits naturally within the white box, moves with the DOM,
//                and needs no position tracking.
//   2. OVERLAY — fallback: button appended to document.body with position:fixed,
//                positioned via the Range API for pixel accuracy. Position is updated
//                on scroll/resize/ResizeObserver.
//
// Features:
//   • Card count — after injection, calls AnkiConnect findCards and updates the
//     button label: "Open in Anki: XXXX (N)" or "Open in Anki: XXXX ✗".
//   • Count retry — if Anki is unreachable at load time, re-checks every 30 s
//     until the count is filled in or the question changes.
//   • Prefetch — after a count is fetched, silently pre-fetches counts for the
//     adjacent items (N-1, N+1) using qidCache. Counts are stored in countCache
//     so navigation to those items shows the count instantly.
//   • Navigation — "Item: X of 40" counter change triggers a 700 ms block window
//     so React can re-render before we re-inject.
//   • MutationObserver watches childList + characterData for full SPA coverage.

(function () {
  'use strict';

  const BTN_ID = 'uw2a-open-anki';
  const LOG    = (...a) => console.log('[UW2A]', ...a);
  const SKIP   = new Set(['SCRIPT','STYLE','NOSCRIPT','IFRAME','SVG','HEAD','META','LINK']);
  const QID_RE = /(?:QId|Question[\s ]+Id(?:entifier)?)[\s ]*:[\s ]*(\d{3,})/i;

  const COUNT_RETRY_MS = 30_000; // retry interval when Anki unreachable

  LOG('Loaded —', location.href);

  // ── Settings ──────────────────────────────────────────────────────────────
  let step = '1';
  try {
    chrome.storage.sync.get({ step: '1' }, (s) => { step = s.step; });
    chrome.storage.onChanged.addListener((changes, area) => {
      if (!alive()) return;
      if (area === 'sync' && changes.step) {
        step       = changes.step.newValue;
        navigating = false;
        clearTimeout(navClearTimer);
        lastQid = null; lastItemNum = null;
        tries   = 0;
        countCache.clear();   // stale counts from old step are invalid
        qidCache.clear();
        removeBtn();
        update();
      }
    });
  } catch (e) { LOG('storage unavailable:', e.message); }

  function buildQuery(qid) {
    const s = step === '3' ? 'Step3' : step === '2' ? 'Step2' : 'Step1';
    return `tag:#AK_${s}_v*::#UWorld*::${qid}`;
  }

  // ── State ─────────────────────────────────────────────────────────────────
  let lastQid     = null;
  let lastItemNum = null;
  let navigating  = false;
  let tries       = 0;

  // hiddenEl: element whose content we replaced (inline) or hid (overlay)
  // savedText: saved innerHTML for inline mode, null = overlay mode
  let hiddenEl  = null;
  let savedText = null;

  // Position-tracking state (overlay mode only)
  let trackedEl       = null;
  let trackedQid      = null;
  let trackedUseElRect = false;
  let trackedValueEl  = null;   // used for el.left → valueEl.right span
  let resizeObs        = null;

  let debounceTimer = null;
  let navClearTimer = null;
  let retryTimer    = null;   // count-retry timer when Anki is offline

  // qidCache: itemNum (string) → qid (string)  — built as user navigates
  // countCache: qid (string) → count (number)  — 0 means "no matching cards"
  const qidCache   = new Map();
  const countCache = new Map();

  function getCurrentItemNum() {
    const m = document.body.textContent.match(/Item\s*:\s*(\d+)\s+of\s+\d+/i);
    return m ? m[1] : null;
  }

  // ── Button factory ────────────────────────────────────────────────────────
  function createBtn(qid) {
    const btn = document.createElement('div');
    btn.id          = BTN_ID;
    btn.textContent = `Open in Anki: ${qid}`;
    btn.title       = buildQuery(qid);

    Object.assign(btn.style, {
      display:      'block',
      padding:      '2px 8px',
      background:   '#ffffff',
      color:        '#1170cf',
      border:       '1px solid #1170cf',
      borderRadius: '4px',
      fontSize:     '12px',
      fontFamily:   'inherit',
      fontWeight:   '600',
      cursor:       'pointer',
      userSelect:   'none',
      lineHeight:   '1.6',
      whiteSpace:   'nowrap',
      boxShadow:    '0 1px 3px rgba(0,0,0,0.12)',
    });

    btn.addEventListener('mouseenter', () => { btn.style.background = '#e8f2fc'; });
    btn.addEventListener('mouseleave', () => { btn.style.background = btn._baseBg ?? '#ffffff'; });

    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const orig = btn.textContent;
      btn.textContent = 'Opening…';
      btn.style.color = '#999';
      try {
        chrome.runtime.sendMessage({ action: 'ankiBrowse', query: buildQuery(qid) }, (res) => {
          try {
            btn.textContent = orig;
            btn.style.color = btn._baseColor ?? '#1170cf';
            const err = chrome.runtime.lastError?.message || res?.error;
            if (err) {
              alert(
                'UWorld2Anki — could not reach Anki.\n\n' +
                'Make sure:\n' +
                '  1. Anki is open\n' +
                '  2. AnkiConnect add-on (2055492159) is installed\n' +
                '  3. AnkiConnect webCorsOriginList includes "https://apps.uworld.com"\n\n' +
                err
              );
            }
          } catch (_) { /* context invalidated */ }
        });
      } catch (err) {
        btn.textContent = orig;
        btn.style.color = btn._baseColor ?? '#1170cf';
        LOG('sendMessage failed:', err.message);
      }
    });

    return btn;
  }

  // ── DOM cleanup ───────────────────────────────────────────────────────────
  function removeBtn() {
    clearTimeout(retryTimer);
    retryTimer = null;
    document.getElementById(BTN_ID)?.remove();
    if (hiddenEl) {
      if (hiddenEl.isConnected) {
        if (savedText !== null) {
          // Inline injection — restore original inner HTML and sizing
          hiddenEl.innerHTML    = savedText;
          hiddenEl.style.minWidth = '';
        } else {
          // Overlay injection — restore visibility
          hiddenEl.style.visibility = '';
        }
      }
      hiddenEl  = null;
      savedText = null;
    }
    stopTracking();
  }

  // ── Find QID element ──────────────────────────────────────────────────────
  // Returns { el, qid, valueEl } where:
  //   el       — deepest element whose textContent matches QID_RE
  //   qid      — the extracted QID string
  //   valueEl  — (optional) child of el whose text is just the bare number,
  //              e.g. UWorld's white "value box" element
  function findQidElement() {
    let best = null, bestLen = Infinity;

    for (const el of document.querySelectorAll('*')) {
      if (SKIP.has(el.tagName)) continue;
      if (el.id === BTN_ID) continue;
      // Only skip hiddenEl in inline-replacement mode (savedText !== null).
      // In overlay mode (savedText === null) el's content is untouched, so
      // skipping it would prevent re-injection after React re-renders.
      if (el === hiddenEl && savedText !== null) continue;
      if (el.style?.visibility === 'hidden') continue;
      const text = el.textContent;
      if (!text || text.length >= bestLen) continue;
      const m = text.match(QID_RE);
      if (m) { bestLen = text.length; best = { el, qid: m[1] }; }
    }

    if (!best) {
      LOG('QID not found. Body snippet:', document.body?.textContent?.slice(0, 200));
      return null;
    }

    // Walk down to deepest child still matching the full pattern
    let refined = best.el;
    let changed  = true;
    while (changed) {
      changed = false;
      for (const child of refined.children) {
        if (child.id === BTN_ID) continue;
        if (child === hiddenEl && savedText !== null) continue;
        if (child.style?.visibility === 'hidden') continue;
        const ct = child.textContent;
        if (ct && ct.length < refined.textContent.length && QID_RE.test(ct)) {
          refined = child;
          changed = true;
          break;
        }
      }
    }

    // Look for a "value element": the deepest descendant of refined whose
    // textContent is exactly the bare QID number (UWorld's white chip).
    // Search all descendants (not just direct children) — UWorld nests the chip
    // multiple levels deep inside the header flex container.
    let valueEl = null;
    const numStr = String(best.qid);
    // querySelectorAll returns document order (parents before children).
    // Reversing gives us leaf nodes first so we find the deepest match.
    for (const desc of Array.from(refined.querySelectorAll('*')).reverse()) {
      if (desc.id === BTN_ID) continue;
      if (desc === hiddenEl && savedText !== null) continue;
      if (desc.closest?.('#' + BTN_ID)) continue;
      if (desc.textContent.replace(/\s/g, '') === numStr) {
        valueEl = desc;
        break;
      }
    }

    LOG('Found QID — qid:', best.qid,
        '| el:', refined.tagName,
        '| text:', JSON.stringify(refined.textContent.trim().slice(0, 60)),
        '| valueEl:', valueEl ? valueEl.tagName : 'none');

    return { el: refined, qid: best.qid, valueEl };
  }

  // ── Get the rect spanning the full "Question Id: XXXX" visual area ─────────
  // Handles UWorld's DOM where "Question Id:" and "XXXX" are in SEPARATE text
  // nodes (e.g. label in plain text, number inside a value chip element).
  // Returns a rect spanning from the left of the label to the right of the number.
  function getQidFullRect(el, qid) {
    // Pass 1: single text node contains the full pattern → use it directly
    {
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tnode;
      while ((tnode = tw.nextNode())) {
        const m = tnode.textContent.match(QID_RE);
        if (!m) continue;
        try {
          const start = tnode.textContent.search(QID_RE);
          const range = document.createRange();
          range.setStart(tnode, start);
          range.setEnd(tnode, start + m[0].length);
          const r = range.getBoundingClientRect();
          if (r.height > 0) return r;
        } catch (_) {}
      }
    }
    // Pass 2: label and number in separate text nodes — combine their rects.
    // First tries the Range API for precision; if that returns height=0 (can
    // happen in some flex containers) falls back to element-level rects.
    {
      const numStr = String(qid);
      let labelRect = null, numRect = null;

      // --- Pass 2a: Range API on text nodes ---
      const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
      let tnode;
      while ((tnode = tw.nextNode())) {
        const text = tnode.textContent;
        try {
          if (!labelRect && /question\s*id/i.test(text)) {
            const idx = text.search(/question\s*id/i);
            const range = document.createRange();
            range.setStart(tnode, idx);
            range.setEnd(tnode, text.length);
            const r = range.getBoundingClientRect();
            if (r.height > 0) labelRect = r;
          }
          if (!numRect) {
            const idx = text.indexOf(numStr);
            if (idx !== -1) {
              const before = text[idx - 1], after = text[idx + numStr.length];
              if ((!before || !/\d/.test(before)) && (!after || !/\d/.test(after))) {
                const range = document.createRange();
                range.setStart(tnode, idx);
                range.setEnd(tnode, idx + numStr.length);
                const r = range.getBoundingClientRect();
                if (r.height > 0) numRect = r;
              }
            }
          }
        } catch (_) {}
        if (labelRect && numRect) break;
      }

      // --- Pass 2b: element-based fallback (more robust in flex containers) ---
      // Walk all descendants deepest-first for reliability.
      const allDesc = () => Array.from(el.querySelectorAll('*')).reverse();

      if (!labelRect) {
        for (const desc of allDesc()) {
          if (desc.id === BTN_ID) continue;
          const t = desc.textContent;
          // Find an element that has "Question Id" but is NOT just the number chip
          if (/question\s*id/i.test(t) && t.replace(/\s/g, '') !== numStr) {
            const r = desc.getBoundingClientRect();
            if (r.height > 0) { labelRect = r; break; }
          }
        }
      }
      if (!numRect) {
        for (const desc of allDesc()) {
          if (desc.id === BTN_ID) continue;
          if (desc.textContent.replace(/\s/g, '') === numStr) {
            const r = desc.getBoundingClientRect();
            if (r.height > 0) { numRect = r; break; }
          }
        }
      }

      if (labelRect && numRect) {
        const top    = Math.min(labelRect.top,    numRect.top);
        const bottom = Math.max(labelRect.bottom, numRect.bottom);
        const left   = Math.min(labelRect.left,   numRect.left);
        const right  = Math.max(labelRect.right,  numRect.right);
        return { top, bottom, left, right, width: right - left, height: bottom - top };
      }
      if (numRect) return numRect;
      if (labelRect) return labelRect;
    }
    return el.getBoundingClientRect(); // last resort
  }

  // Legacy alias — kept for any internal uses that need the number-only rect
  function getQidRect(el, qid) { return getQidFullRect(el, qid); }

  // ── Position tracking (overlay mode) ─────────────────────────────────────
  function reposition() {
    const btn = document.getElementById(BTN_ID);
    if (!btn || !trackedEl || !trackedQid) return;
    if (trackedUseElRect) {
      const elRect = trackedEl.getBoundingClientRect();
      if (!elRect || elRect.height === 0) return;
      btn.style.top    = Math.round(elRect.top)    + 'px';
      btn.style.height = Math.round(elRect.height) + 'px';
      if (trackedValueEl && trackedValueEl.isConnected) {
        // Span from el's left edge to valueEl's right edge
        // (covers "Question Id:" label through the value chip)
        const valRect = trackedValueEl.getBoundingClientRect();
        btn.style.left  = Math.round(elRect.left)              + 'px';
        btn.style.width = Math.round(valRect.right - elRect.left) + 'px';
      } else {
        btn.style.left  = Math.round(elRect.left)  + 'px';
        btn.style.width = Math.round(elRect.width) + 'px';
      }
    } else {
      const rect = getQidRect(trackedEl, trackedQid);
      if (rect && rect.height > 0) {
        btn.style.top    = Math.round(rect.top)    + 'px';
        btn.style.left   = Math.round(rect.left)   + 'px';
        btn.style.width  = Math.round(rect.width)  + 'px';
        btn.style.height = Math.round(rect.height) + 'px';
      }
    }
  }

  function startTracking(el, qid, useElRect = false, valueEl = null) {
    stopTracking();
    trackedEl       = el;
    trackedQid      = qid;
    trackedUseElRect = useElRect;
    trackedValueEl  = valueEl;
    window.addEventListener('scroll', reposition, { passive: true, capture: true });
    window.addEventListener('resize', reposition, { passive: true });
    if (typeof ResizeObserver !== 'undefined') {
      resizeObs = new ResizeObserver(reposition);
      resizeObs.observe(document.documentElement);
      if (el?.isConnected) resizeObs.observe(el);
    }
  }

  function stopTracking() {
    window.removeEventListener('scroll', reposition, { capture: true });
    window.removeEventListener('resize', reposition);
    if (resizeObs) { resizeObs.disconnect(); resizeObs = null; }
    trackedEl       = null;
    trackedQid      = null;
    trackedUseElRect = false;
    trackedValueEl  = null;
  }

  // ── Card count ────────────────────────────────────────────────────────────

  // Apply a resolved count (number) to the visible button.
  function applyCount(btn, qid, count) {
    if (count === 0) {
      btn.textContent  = `Open in Anki: ${qid} ✗`;
      btn._baseColor   = '#aaa';
      btn.style.color  = '#aaa';
      btn.style.border = '1px solid #ddd';
      btn.title        = buildQuery(qid) + ' — no cards found';
    } else {
      btn.textContent = `Open in Anki: ${qid} (${count})`;
      btn.title       = buildQuery(qid) + ` — ${count} card${count === 1 ? '' : 's'}`;
    }
  }

  // Schedule a re-check in COUNT_RETRY_MS.
  // Only fires if the button still shows no count (no "(N)" or "✗" suffix).
  function scheduleCountRetry(qid) {
    clearTimeout(retryTimer);
    retryTimer = setTimeout(() => {
      retryTimer = null;
      if (!alive() || lastQid !== qid) return;
      const btn = document.getElementById(BTN_ID);
      if (!btn) return;
      // Only retry if count badge is still missing
      if (btn.textContent === `Open in Anki: ${qid}`) {
        LOG('Retrying card count for', qid);
        fetchCardCount(qid);
      }
    }, COUNT_RETRY_MS);
  }

  // Silently pre-fetch the count for an adjacent qid (no UI update on current button).
  function prefetchOne(qid) {
    if (!qid || countCache.has(qid) || !alive()) return;
    try {
      chrome.runtime.sendMessage(
        { action: 'ankiCount', query: buildQuery(qid) },
        (res) => {
          if (!alive() || chrome.runtime.lastError || res?.error) return;
          const count = Array.isArray(res?.result) ? res.result.length : null;
          if (count !== null) {
            countCache.set(qid, count);
            LOG('Prefetched count for', qid, '→', count);
          }
        }
      );
    } catch (_) {}
  }

  // After successfully fetching the current item's count, kick off silent
  // prefetches for the items immediately before and after in navigation order.
  function prefetchAdjacent(itemNum) {
    if (!itemNum) return;
    const n = parseInt(itemNum, 10);
    if (isNaN(n)) return;
    // Small delay so the current message channel closes first
    setTimeout(() => {
      prefetchOne(qidCache.get(String(n - 1)));
      prefetchOne(qidCache.get(String(n + 1)));
    }, 150);
  }

  // Fetch (or serve from cache) the card count for qid.
  // On success: stores in countCache, updates button, prefetches adjacent items.
  // On failure: schedules a retry in COUNT_RETRY_MS.
  function fetchCardCount(qid) {
    if (!alive()) return;

    // Serve from cache immediately
    if (countCache.has(qid)) {
      if (lastQid !== qid) return;
      const btn = document.getElementById(BTN_ID);
      if (btn) applyCount(btn, qid, countCache.get(qid));
      return;
    }

    try {
      chrome.runtime.sendMessage(
        { action: 'ankiCount', query: buildQuery(qid) },
        (res) => {
          if (!alive()) return;
          if (lastQid !== qid) return;              // navigated away
          const btn = document.getElementById(BTN_ID);
          if (!btn) return;

          if (chrome.runtime.lastError || res?.error) {
            // Anki unreachable — schedule retry so count fills in once Anki opens
            scheduleCountRetry(qid);
            return;
          }

          const count = Array.isArray(res?.result) ? res.result.length : null;
          if (count === null) return;

          countCache.set(qid, count);
          applyCount(btn, qid, count);
          prefetchAdjacent(lastItemNum);
        }
      );
    } catch (e) { LOG('fetchCardCount:', e.message); }
  }

  // ── Inject button ─────────────────────────────────────────────────────────
  // Always position:fixed overlay; never touch el.style.visibility (React reverts it).
  //
  // Priority:
  //   1. valueEl found → span from el.left to valueEl.right (covers "Question Id:" + chip)
  //   2. el is pure QID content → cover el's full bounding rect
  //   3. fallback → Range-precise rect over just the QID text
  function injectBtn(el, qid, valueEl) {
    removeBtn();
    const btn = createBtn(qid);

    // applyOverlay: position the button and start scroll/resize tracking.
    // hiddenEl is NOT set here in overlay mode (savedText stays null) because:
    //   • We never modify el's content in overlay mode (React would revert it anyway)
    //   • Setting hiddenEl=el would cause findQidElement to skip the tracked element
    //     on the next update(), preventing re-injection after React re-renders.
    // Disconnection is detected via trackedEl.isConnected in update() instead.
    const applyOverlay = (left, top, width, height, useElRect, velForTrack) => {
      Object.assign(btn.style, {
        position:       'fixed',
        top:            Math.round(top)    + 'px',
        left:           Math.round(left)   + 'px',
        width:          Math.round(width)  + 'px',
        height:         Math.round(height) + 'px',
        zIndex:         '2147483647',
        display:        'flex',
        alignItems:     'center',
        justifyContent: 'center',
      });
      document.body.appendChild(btn);
      hiddenEl  = null;   // overlay mode — el content is untouched
      savedText = null;
      startTracking(el, qid, useElRect, velForTrack);
      fetchCardCount(qid);
    };

    // Mode 1 — valueEl found: use getQidFullRect for left edge + height so the
    // button covers exactly the "Question Id: XXXX" span (not the full header).
    // valueEl.right is used as the right anchor when it extends past the text rect.
    if (valueEl && valueEl.isConnected) {
      const fullRect = getQidFullRect(el, qid);
      const valRect  = valueEl.getBoundingClientRect();
      if (fullRect && fullRect.height > 0 && valRect.height > 0) {
        const left  = fullRect.left;
        const right = Math.max(fullRect.right, valRect.right);
        const width = right - left;
        LOG('Injected Mode 1 (valueEl) overlay w=', width.toFixed(0));
        applyOverlay(left, fullRect.top, width, fullRect.height, false, null);
        return;
      }
    }

    // Mode 2 — el is pure QID content (no other text): cover el's full rect.
    const otherText = el.textContent.replace(QID_RE, '').replace(/\s/g, '');
    if (otherText.length === 0 && el.parentElement) {
      const elRect = el.getBoundingClientRect();
      if (elRect.height > 0) {
        LOG('Injected Mode 2 (pure el) overlay');
        applyOverlay(elRect.left, elRect.top, elRect.width, elRect.height, true, null);
        return;
      }
    }

    // Mode 3 — fallback: getQidFullRect spans "Question Id:" label to number end.
    const rect = getQidFullRect(el, qid);
    if (!rect || rect.height === 0) { LOG('injectBtn: zero rect — aborting'); return; }
    LOG('Injected Mode 3 (getQidFullRect) overlay w=', rect.width.toFixed(0));
    applyOverlay(rect.left, rect.top, rect.width, rect.height, false, null);
  }

  // ── Navigation ────────────────────────────────────────────────────────────
  function onNavigate(oldItem, newItem) {
    LOG('Navigation:', oldItem, '→', newItem);
    lastQid = null; lastItemNum = null; tries = 0;
    removeBtn(); // also clears retryTimer
    navigating = true;
    clearTimeout(navClearTimer);
    navClearTimer = setTimeout(() => {
      navigating = false;
      tries      = 0;
      tryInit();
    }, 150);   // safety-net; early-exit in MutationObserver fires much sooner
  }

  // ── Main update ───────────────────────────────────────────────────────────
  function update() {
    if (!alive()) { shutdown(); return; }
    if (navigating) return;

    const curItem  = getCurrentItemNum();
    const btnInDom = !!document.getElementById(BTN_ID);

    // If the tracked element was replaced by React, reset and re-inject.
    // We check trackedEl (not hiddenEl) because overlay mode no longer sets
    // hiddenEl — el content is untouched, only the button position is tracked.
    if (trackedEl && !trackedEl.isConnected) {
      LOG('trackedEl disconnected — resetting');
      clearTimeout(retryTimer);
      retryTimer = null;
      hiddenEl = null; savedText = null;
      lastQid  = null; lastItemNum = null;
      if (btnInDom) document.getElementById(BTN_ID)?.remove();
      stopTracking();
    }

    // Navigation detection
    if (lastItemNum !== null && curItem !== null && curItem !== lastItemNum) {
      onNavigate(lastItemNum, curItem);
      return;
    }

    if (btnInDom && lastQid !== null) return;

    const r = findQidElement();
    if (!r) { if (btnInDom) removeBtn(); return; }

    if (r.qid !== lastQid || !btnInDom) {
      lastQid     = r.qid;
      lastItemNum = curItem ?? getCurrentItemNum();
      tries       = 0;
      // Record item→qid mapping so prefetchAdjacent can look up neighbours
      if (lastItemNum) qidCache.set(lastItemNum, lastQid);
      injectBtn(r.el, r.qid, r.valueEl);
    }
  }

  // ── Retry loop ────────────────────────────────────────────────────────────
  function tryInit() {
    if (!alive()) { shutdown(); return; }
    update();
    if (!document.getElementById(BTN_ID) && tries++ < 30) {
      setTimeout(tryInit, 200);
    }
  }

  // ── Context guard ─────────────────────────────────────────────────────────
  function alive() {
    try { return !!chrome.runtime?.id; } catch { return false; }
  }

  function shutdown() {
    mo.disconnect();
    clearInterval(urlTimer);
    clearTimeout(debounceTimer);
    clearTimeout(navClearTimer);
    clearTimeout(retryTimer);
    navigating = false;
    removeBtn();
    LOG('Shutdown');
  }

  // ── Boot ──────────────────────────────────────────────────────────────────
  setTimeout(tryInit, 50);

  // MutationObserver — childList for element changes, characterData for text-node
  // mutations (in case UWorld updates the QID text in place without replacing the node).
  //
  // Two debounce tiers:
  //   • NAV PEEK  (16 ms ≈ 1 frame) — during a nav window, check each mutation
  //     batch for the new content. Fires the moment React commits its render tree,
  //     cancels the safety-net timer, and injects immediately. This is what makes
  //     the button appear fast after switching questions.
  //   • NORMAL    (30 ms) — outside nav, batch rapid mutations before calling update().
  const mo = new MutationObserver(() => {
    if (!alive()) { shutdown(); return; }
    clearTimeout(debounceTimer);
    const delay = navigating ? 16 : 30;
    debounceTimer = setTimeout(() => {
      if (navigating) {
        // Peek: if the new question's QID is already in the DOM, cancel the
        // nav block early and inject now rather than waiting for the safety net.
        if (findQidElement() !== null && getCurrentItemNum() !== null) {
          LOG('Early nav exit — new content ready');
          clearTimeout(navClearTimer);
          navigating = false;
          tries = 0;
          update();
        }
        return;
      }
      update();
    }, delay);
  });
  mo.observe(document.body, {
    childList:             true,
    subtree:               true,
    characterData:         true,
    characterDataSubtree:  true,
  });

  // URL fallback for any navigation that changes the URL
  let lastUrl = location.href;
  const urlTimer = setInterval(() => {
    if (!alive()) { shutdown(); return; }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      onNavigate(lastItemNum, null);
    }
  }, 500);

})();
