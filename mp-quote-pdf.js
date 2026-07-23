/* ============================================================================
   Miller and Partner - Quote Form PDF Submission Module
   ----------------------------------------------------------------------------
   Reads any .mp-quote-form on the page, builds a house-styled PDF of the
   completed form, attaches it to the Formspree submission, and posts it.

   Paste this inside a script tag at the bottom of the form's Custom Code
   element, or host it and reference it by src. It self-initialises on any
   page containing a .mp-quote-form. No changes are needed to the form markup.

   The PDF goes to Miller and Partner only. The client does not receive a copy.

   NOTE: this file deliberately contains no angle-bracket tag text anywhere,
   including in comments, because page builders mangle it.

   v3 changes:
     - A successful send is latched. The native fallback can never fire
       afterwards, so a failure while drawing the confirmation screen can no
       longer cause a second duplicate submission.
     - jsPDF load has a hard timeout, so a blocked CDN submits without the
       attachment instead of hanging.
     - Failed validation now names the offending fields instead of doing
       nothing visible.
   ========================================================================== */

(function () {
  'use strict';

  /* ---------------------------------------------------------------------
     CONFIG
     ------------------------------------------------------------------ */
  var CFG = {
    formSelector: '.mp-quote-form',

    // jsPDF is loaded on demand from CDN.
    jsPDFUrl: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',

    // Give up on the CDN after this many ms and submit without a PDF.
    jsPDFTimeoutMs: 8000,

    // Field name the PDF is attached under. Any name works.
    attachmentFieldName: 'completed_form_pdf',

    // Brand
    navy:   [21, 56, 102],    // 153866
    gold:   [191, 156, 16],   // BF9C10
    ink:    [34, 34, 34],
    muted:  [100, 100, 100],
    light:  [248, 250, 252],
    border: [223, 230, 238],
    white:  [255, 255, 255],

    // Firm details for the PDF footer
    firmName: 'Miller & Partner Ltd',
    firmAddress: 'Vivian House, Roman Bridge Close, Mumbles, Swansea SA3 5BG',
    firmContact: 'enquiries@millerandpartner.co.uk  |  01792 001350',
    firmReg: 'Appointed Representative of Gauntlet Risk Management Ltd  |  FCA Firm Ref 1029698',

    // Page geometry (mm, A4)
    margin: 15,
    headerHeight: 24,
    footerReserve: 20,

    // Show optional fields that were left blank. Selects and required fields
    // are always shown as "Not answered" regardless of this setting.
    includeEmptyOptional: false,

    // Rewrite the Formspree _subject to include the proposer name and date.
    setSubject: true,

    // Set to true in the console to trace what the module is doing.
    debug: false
  };

  /* ---------------------------------------------------------------------
     SMALL HELPERS
     ------------------------------------------------------------------ */
  function each(list, fn) { Array.prototype.forEach.call(list || [], fn); }

  function log() {
    if (CFG.debug && window.console) console.log.apply(console, ['[mp-pdf]'].concat([].slice.call(arguments)));
  }

  function txt(el) {
    return (el && el.textContent ? el.textContent : '').replace(/\s+/g, ' ').trim();
  }

  // jsPDF standard fonts use WinAnsi. Normalise typographic characters that
  // commonly arrive from pasted text so nothing renders as a blank box.
  function clean(s) {
    return String(s == null ? '' : s)
      .replace(/[\u2018\u2019\u201A\u2032]/g, "'")
      .replace(/[\u201C\u201D\u201E\u2033]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u2026/g, '...')
      .replace(/\u00A0/g, ' ')
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function isVisible(el) {
    if (!el) return false;
    return el.getClientRects().length > 0;
  }

  function labelOf(group) {
    var l = group.querySelector(':scope > label');
    if (!l) return '';
    var c = l.cloneNode(true);
    each(c.querySelectorAll('.required'), function (s) { s.parentNode.removeChild(s); });
    return txt(c).replace(/\s*\*\s*$/, '').trim();
  }

  function valueOf(ctrl) {
    if (!ctrl) return '';
    if (ctrl.tagName === 'SELECT') {
      if (!ctrl.value) return '';
      var opt = ctrl.options[ctrl.selectedIndex];
      return (opt ? opt.text : ctrl.value).trim();
    }
    if (ctrl.type === 'checkbox') return ctrl.checked ? (ctrl.value || 'Yes') : '';
    if (ctrl.type === 'radio') return ctrl.checked ? (ctrl.value || 'Yes') : '';
    if (ctrl.type === 'date' && ctrl.value) {
      var p = ctrl.value.split('-');
      if (p.length === 3) return p[2] + '/' + p[1] + '/' + p[0];
    }
    return (ctrl.value || '').trim();
  }

  function todayUK() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return p(d.getDate()) + '/' + p(d.getMonth() + 1) + '/' + d.getFullYear();
  }

  function stamp() {
    var d = new Date();
    function p(n) { return (n < 10 ? '0' : '') + n; }
    return todayUK() + ' at ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  function slug(s) {
    return String(s || '').replace(/[^a-z0-9]+/gi, '-').replace(/^-+|-+$/g, '').slice(0, 60);
  }

  /* ---------------------------------------------------------------------
     PARSE - walk the form and produce an ordered list of blocks
     ------------------------------------------------------------------ */
  var SKIP = 'button, .mp-add-row, .mp-remove-row, .mp-submit-wrap, ' +
             '.mp-required-note, .mp-note, .mp-pct-total, template, script, style';

  function parseForm(form) {
    var blocks = [];
    walk(form, blocks);
    return blocks;
  }

  function walk(node, blocks) {
    each(node.children, function (el) {
      if (!el || !el.tagName) return;
      if (el.matches && el.matches(SKIP)) return;
      if (el.tagName === 'INPUT' && el.type === 'hidden') return;

      var cl = el.classList;

      if (cl.contains('mp-section-title')) { blocks.push({ t: 'section', text: txt(el) }); return; }
      if (cl.contains('mp-subsection'))    { blocks.push({ t: 'subsection', text: txt(el) }); return; }
      if (cl.contains('mp-question'))      { blocks.push({ t: 'question', text: txt(el) }); return; }
      if (cl.contains('mp-inline-note'))   { blocks.push({ t: 'note', text: txt(el) }); return; }
      if (cl.contains('mp-declaration-text')) { blocks.push({ t: 'declaration', text: txt(el) }); return; }

      if (cl.contains('mp-consent')) {
        var cb = el.querySelector('input[type="checkbox"]');
        blocks.push({
          t: 'field',
          label: txt(el).replace(/\s*\*\s*$/, ''),
          value: cb && cb.checked ? 'Confirmed' : 'NOT CONFIRMED',
          flag: !(cb && cb.checked)
        });
        return;
      }

      // Conditional blocks only count if the user actually revealed them.
      if (cl.contains('mp-conditional')) {
        if (isVisible(el)) walk(el, blocks);
        return;
      }

      if (cl.contains('mp-repeater'))    { pushRepeater(el, blocks); return; }

      if (cl.contains('mp-table-scroll')) {
        var tbl = el.querySelector('.mp-income-table, .mp-turnover-table');
        if (tbl) pushTable(tbl, blocks);
        return;
      }

      if (cl.contains('mp-form-group'))  { pushField(el, blocks); return; }

      // Anything else (e.g. .mp-form-grid) is a container - recurse.
      walk(el, blocks);
    });
  }

  function pushField(group, blocks) {
    var ctrl = group.querySelector('input, select, textarea');
    if (!ctrl || ctrl.type === 'hidden') return;

    var label = labelOf(group) || ctrl.name || '';
    var value = valueOf(ctrl);

    if (!value) {
      var mustShow = (ctrl.tagName === 'SELECT') || ctrl.required || CFG.includeEmptyOptional;
      if (!mustShow) return;
      value = 'Not answered';
    }

    blocks.push({
      t: 'field',
      label: label,
      value: value,
      flag: value === 'Not answered' && ctrl.required
    });
  }

  function pushRepeater(rep, blocks) {
    var rows = [];
    each(rep.querySelectorAll('.mp-repeater-row'), function (row) {
      var pairs = [];
      each(row.querySelectorAll('.mp-form-group'), function (g) {
        var c = g.querySelector('input, select, textarea');
        if (!c) return;
        var v = valueOf(c);
        if (!v) return;
        pairs.push({ label: labelOf(g), value: v });
      });
      if (pairs.length) rows.push(pairs);
    });
    if (rows.length) blocks.push({ t: 'repeater', rows: rows });
  }

  function pushTable(tbl, blocks) {
    var heads = [], cells = [];

    each(tbl.children, function (ch) {
      if (ch.classList.contains('mp-th'))       { heads.push(txt(ch)); return; }
      if (ch.classList.contains('mp-td-label')) { cells.push(txt(ch)); return; }
      if (ch.tagName === 'INPUT' || ch.tagName === 'SELECT' || ch.tagName === 'TEXTAREA') {
        cells.push(valueOf(ch));
      }
    });

    var cols = heads.length;
    if (!cols) return;

    var rows = [];
    for (var i = 0; i < cells.length; i += cols) {
      var r = cells.slice(i, i + cols);
      while (r.length < cols) r.push('');
      var hasData = r.some(function (v, idx) { return idx > 0 && v !== ''; });
      if (hasData) rows.push(r);
    }

    if (rows.length) blocks.push({ t: 'table', head: heads, rows: rows });
  }

  /* ---------------------------------------------------------------------
     RENDER - draw the blocks into a jsPDF document
     ------------------------------------------------------------------ */
  function Renderer(title) {
    var jsPDF = window.jspdf.jsPDF;
    this.doc = new jsPDF({ unit: 'mm', format: 'a4', compress: true });
    this.pw = this.doc.internal.pageSize.getWidth();
    this.ph = this.doc.internal.pageSize.getHeight();
    this.title = title;
    this.y = 0;
    this.band();
  }

  Renderer.prototype.fill = function (c) { this.doc.setFillColor(c[0], c[1], c[2]); return this; };
  Renderer.prototype.ink  = function (c) { this.doc.setTextColor(c[0], c[1], c[2]); return this; };
  Renderer.prototype.line = function (c) { this.doc.setDrawColor(c[0], c[1], c[2]); return this; };
  Renderer.prototype.font = function (style, size) {
    this.doc.setFont('helvetica', style);
    this.doc.setFontSize(size);
    return this;
  };

  Renderer.prototype.band = function () {
    var d = this.doc, h = CFG.headerHeight;
    this.fill(CFG.navy); d.rect(0, 0, this.pw, h, 'F');
    this.fill(CFG.gold); d.rect(0, h, this.pw, 1.2, 'F');

    this.font('bold', 13).ink(CFG.white);
    d.text('MILLER & PARTNER', CFG.margin, 11);

    this.font('normal', 7.5).ink([214, 224, 236]);
    d.text('Specialist UK Commercial Insurance Broker', CFG.margin, 16.5);

    this.font('normal', 7.5).ink([214, 224, 236]);
    var lines = d.splitTextToSize(clean(this.title), 78);
    d.text(lines.slice(0, 2), this.pw - CFG.margin, 11, { align: 'right' });

    this.y = h + 10;
  };

  Renderer.prototype.room = function (h) {
    if (this.y + h > this.ph - CFG.footerReserve) {
      this.doc.addPage();
      this.band();
      return true;
    }
    return false;
  };

  // Wrapped text. Returns the height consumed.
  Renderer.prototype.para = function (text, o) {
    o = o || {};
    var size = o.size || 9;
    var indent = o.indent || 0;
    var width = (o.width || (this.pw - CFG.margin * 2)) - indent;
    var lh = size * 0.45;

    this.font(o.style || 'normal', size).ink(o.color || CFG.ink);
    var lines = this.doc.splitTextToSize(clean(text), width);

    for (var i = 0; i < lines.length; i++) {
      this.room(lh + 1);
      this.doc.text(lines[i], CFG.margin + indent, this.y + lh * 0.8);
      this.y += lh;
      // Re-apply after a possible page break reset.
      this.font(o.style || 'normal', size).ink(o.color || CFG.ink);
    }
    return lines.length * lh;
  };

  Renderer.prototype.gap = function (n) { this.y += n; };

  Renderer.prototype.section = function (text) {
    this.room(20);
    this.gap(5);
    this.para(text, { style: 'bold', size: 12, color: CFG.navy });
    this.gap(1.5);
    this.line(CFG.gold);
    this.doc.setLineWidth(0.6);
    this.doc.line(CFG.margin, this.y, this.pw - CFG.margin, this.y);
    this.doc.setLineWidth(0.2);
    this.gap(4);
  };

  Renderer.prototype.question = function (text) {
    this.room(12);
    this.gap(3);
    this.para(text, { style: 'bold', size: 9.5, color: CFG.navy });
    this.gap(1.5);
  };

  Renderer.prototype.subsection = function (text) {
    this.room(10);
    this.gap(2.5);
    this.para(text, { style: 'bold', size: 9, color: CFG.navy });
    this.gap(1);
  };

  Renderer.prototype.note = function (text) {
    this.gap(1);
    this.para(text, { style: 'italic', size: 7.5, color: CFG.muted });
    this.gap(1.5);
  };

  Renderer.prototype.field = function (b) {
    this.room(12);
    this.para(b.label, { style: 'bold', size: 8, color: CFG.navy });
    this.para(b.value, {
      size: 9.5,
      indent: 3,
      color: b.flag ? [176, 58, 16] : CFG.ink
    });
    this.gap(2.5);
  };

  Renderer.prototype.declaration = function (text) {
    var size = 7.8, lh = size * 0.45;
    var width = this.pw - CFG.margin * 2 - 8;
    this.font('normal', size);
    var lines = this.doc.splitTextToSize(clean(text), width);
    var boxH = lines.length * lh + 8;

    this.room(boxH + 4);
    this.gap(2);

    this.fill(CFG.light).line(CFG.border);
    this.doc.roundedRect(CFG.margin, this.y, this.pw - CFG.margin * 2, boxH, 1.5, 1.5, 'FD');

    this.font('normal', size).ink(CFG.ink);
    var ty = this.y + 5.5;
    for (var i = 0; i < lines.length; i++) {
      this.doc.text(lines[i], CFG.margin + 4, ty);
      ty += lh;
    }
    this.y += boxH + 3;
  };

  Renderer.prototype.repeater = function (rows) {
    var self = this;
    rows.forEach(function (pairs, idx) {
      var lh = 4.0;
      var est = pairs.length * (lh * 2) + 9;
      self.room(Math.min(est, 60));
      self.gap(1.5);

      var top = self.y;
      var startPage = self.doc.internal.getCurrentPageInfo().pageNumber;

      self.y += 4;
      pairs.forEach(function (p) {
        self.para(p.label, { style: 'bold', size: 7.5, color: CFG.navy, indent: 4 });
        self.para(p.value, { size: 9, indent: 4 });
        self.gap(1.2);
      });
      self.y += 2;

      // Only draw the surrounding box when the row did not straddle a page.
      var endPage = self.doc.internal.getCurrentPageInfo().pageNumber;
      if (endPage === startPage) {
        self.doc.setPage(startPage);
        self.line(CFG.border);
        self.doc.setLineWidth(0.2);
        self.doc.roundedRect(CFG.margin, top, self.pw - CFG.margin * 2, self.y - top, 1.5, 1.5, 'D');
        self.doc.setPage(endPage);
      }

      if (idx < rows.length - 1) self.gap(1.5);
    });
    this.gap(2);
  };

  Renderer.prototype.table = function (head, rows) {
    var self = this;
    var cols = head.length;
    var total = this.pw - CFG.margin * 2;

    // First column carries the row label and needs more room.
    var weights = [];
    for (var i = 0; i < cols; i++) weights.push(i === 0 ? 2.4 : 1);
    var sum = weights.reduce(function (a, b) { return a + b; }, 0);
    var widths = weights.map(function (w) { return (w / sum) * total; });

    function drawHead() {
      self.room(9);
      self.fill(CFG.navy);
      self.doc.rect(CFG.margin, self.y, total, 7, 'F');
      self.font('bold', 7.5).ink(CFG.white);
      var x = CFG.margin;
      for (var c = 0; c < cols; c++) {
        var t = self.doc.splitTextToSize(clean(head[c]), widths[c] - 3)[0] || '';
        self.doc.text(t, x + 1.5, self.y + 4.7);
        x += widths[c];
      }
      self.y += 7;
    }

    this.gap(2);
    drawHead();

    rows.forEach(function (row, ri) {
      // Measure the tallest cell so the row height fits its content.
      self.font('normal', 8);
      var wrapped = [], maxLines = 1;
      for (var c = 0; c < cols; c++) {
        var w = self.doc.splitTextToSize(clean(row[c] || ''), widths[c] - 3);
        wrapped.push(w);
        if (w.length > maxLines) maxLines = w.length;
      }
      var lh = 3.6;
      var rowH = maxLines * lh + 3.4;

      if (self.y + rowH > self.ph - CFG.footerReserve) {
        self.doc.addPage();
        self.band();
        drawHead();
      }

      if (ri % 2 === 1) {
        self.fill(CFG.light);
        self.doc.rect(CFG.margin, self.y, total, rowH, 'F');
      }

      self.line(CFG.border);
      self.doc.setLineWidth(0.2);
      self.doc.line(CFG.margin, self.y + rowH, CFG.margin + total, self.y + rowH);

      var x = CFG.margin;
      for (var c2 = 0; c2 < cols; c2++) {
        self.font(c2 === 0 ? 'bold' : 'normal', 8).ink(c2 === 0 ? CFG.navy : CFG.ink);
        var ty = self.y + 3.6;
        for (var l = 0; l < wrapped[c2].length; l++) {
          self.doc.text(wrapped[c2][l], x + 1.5, ty);
          ty += lh;
        }
        x += widths[c2];
      }
      self.y += rowH;
    });

    this.gap(3);
  };

  Renderer.prototype.meta = function (formName, proposer) {
    this.font('bold', 15).ink(CFG.navy);
    this.para(formName, { style: 'bold', size: 15, color: CFG.navy });
    this.gap(1);
    if (proposer) {
      this.para(proposer, { style: 'normal', size: 11, color: CFG.ink });
      this.gap(0.5);
    }
    this.para('Submitted ' + stamp(), { size: 8, color: CFG.muted });
    this.gap(3);
    this.line(CFG.border);
    this.doc.setLineWidth(0.3);
    this.doc.line(CFG.margin, this.y, this.pw - CFG.margin, this.y);
    this.gap(2);
  };

  Renderer.prototype.footers = function () {
    var n = this.doc.getNumberOfPages();
    for (var i = 1; i <= n; i++) {
      this.doc.setPage(i);
      var fy = this.ph - 13;
      this.line(CFG.border);
      this.doc.setLineWidth(0.2);
      this.doc.line(CFG.margin, fy, this.pw - CFG.margin, fy);

      this.font('normal', 6.5).ink(CFG.muted);
      this.doc.text(clean(CFG.firmName + '  |  ' + CFG.firmAddress), CFG.margin, fy + 4);
      this.doc.text(clean(CFG.firmContact), CFG.margin, fy + 7);
      this.doc.text(clean(CFG.firmReg), CFG.margin, fy + 10);

      this.font('bold', 6.5).ink(CFG.navy);
      this.doc.text('Page ' + i + ' of ' + n, this.pw - CFG.margin, fy + 4, { align: 'right' });
    }
  };

  Renderer.prototype.run = function (blocks) {
    var self = this;
    blocks.forEach(function (b) {
      switch (b.t) {
        case 'section':     self.section(b.text); break;
        case 'question':    self.question(b.text); break;
        case 'subsection':  self.subsection(b.text); break;
        case 'note':        self.note(b.text); break;
        case 'field':       self.field(b); break;
        case 'repeater':    self.repeater(b.rows); break;
        case 'table':       self.table(b.head, b.rows); break;
        case 'declaration': self.declaration(b.text); break;
      }
    });
    this.footers();
    return this.doc;
  };

  /* ---------------------------------------------------------------------
     BUILD
     ------------------------------------------------------------------ */
  function formTitle(form) {
    var hidden = form.querySelector('input[name="form_name"]');
    if (hidden && hidden.value) return hidden.value;
    var container = form.closest('.mp-quote-form-container');
    var h1 = container ? container.querySelector('h1') : null;
    return h1 ? txt(h1) : 'Quote Request';
  }

  function proposerOf(form) {
    var names = ['proposer_name', 'company_name', 'business_name', 'contact_name'];
    for (var i = 0; i < names.length; i++) {
      var el = form.querySelector('[name="' + names[i] + '"]');
      if (el && el.value && el.value.trim()) return el.value.trim();
    }
    return '';
  }

  function buildPDF(form) {
    var title = formTitle(form);
    var proposer = proposerOf(form);
    var blocks = parseForm(form);
    log('parsed blocks:', blocks.length);

    var r = new Renderer(title);
    r.meta(title, proposer);
    var doc = r.run(blocks);

    var out = {
      blob: doc.output('blob'),
      filename: [slug(title), slug(proposer) || 'submission', new Date().toISOString().slice(0, 10)]
        .filter(Boolean).join('_') + '.pdf',
      title: title,
      proposer: proposer
    };
    log('pdf built:', out.filename, Math.round(out.blob.size / 1024) + 'KB');
    return out;
  }

  /* ---------------------------------------------------------------------
     DEPENDENCY
     ------------------------------------------------------------------ */
  var jsPDFPromise = null;
  function loadJsPDF() {
    if (window.jspdf && window.jspdf.jsPDF) return Promise.resolve();
    if (jsPDFPromise) return jsPDFPromise;

    jsPDFPromise = new Promise(function (resolve, reject) {
      var settled = false;
      function ok()  { if (!settled) { settled = true; resolve(); } }
      function bad(m) { if (!settled) { settled = true; jsPDFPromise = null; reject(new Error(m)); } }

      var s = document.createElement('script');
      s.src = CFG.jsPDFUrl;
      s.async = true;
      s.onload = function () {
        if (window.jspdf && window.jspdf.jsPDF) ok();
        else bad('jsPDF loaded but global missing');
      };
      s.onerror = function () { bad('jsPDF request blocked or failed'); };
      document.head.appendChild(s);

      // A blocked request can hang rather than error. Do not wait forever.
      setTimeout(function () { bad('jsPDF load timed out'); }, CFG.jsPDFTimeoutMs);
    });

    return jsPDFPromise;
  }

  /* ---------------------------------------------------------------------
     VALIDATION FEEDBACK
     ------------------------------------------------------------------ */
  function firstInvalid(form) {
    var bad = form.querySelectorAll(':invalid');
    if (!bad.length) return null;

    for (var i = 0; i < bad.length; i++) {
      var el = bad[i];
      var group = el.closest ? el.closest('.mp-form-group, .mp-consent') : null;
      var name = (group ? labelOf(group) : '') || el.name || 'a required field';
      // Prefer a field the user can actually see.
      if (isVisible(el)) return { el: el, name: name, hidden: false };
    }
    var f = bad[0];
    var g = f.closest ? f.closest('.mp-form-group, .mp-consent') : null;
    return { el: f, name: (g ? labelOf(g) : '') || f.name || 'a required field', hidden: true };
  }

  function showValidationNotice(form, info) {
    var id = 'mp-validation-notice';
    var old = document.getElementById(id);
    if (old && old.parentNode) old.parentNode.removeChild(old);

    var box = document.createElement('div');
    box.id = id;
    box.setAttribute('style',
      'margin:14px 0;padding:12px 14px;border:1px solid #BF3B10;border-radius:6px;' +
      'background:#fdf3f0;color:#8a2b0c;font-size:0.9rem;line-height:1.45;' +
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;');
    box.textContent = 'Please complete "' + info.name + '" before submitting.' +
      (info.hidden ? ' It may be inside a section that is not currently open.' : '');

    var wrap = form.querySelector('.mp-submit-wrap');
    if (wrap && wrap.parentNode) wrap.parentNode.insertBefore(box, wrap);
    else form.appendChild(box);

    try {
      if (info.el && !info.hidden) {
        info.el.scrollIntoView({ behavior: 'smooth', block: 'center' });
        info.el.focus({ preventScroll: true });
      } else {
        box.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    } catch (e) { /* non-fatal */ }
  }

  function clearValidationNotice() {
    var old = document.getElementById('mp-validation-notice');
    if (old && old.parentNode) old.parentNode.removeChild(old);
  }

  /* ---------------------------------------------------------------------
     CONFIRMATION SCREEN
     ------------------------------------------------------------------ */
  function showConfirmation(form) {
    var container = (form.closest && form.closest('.mp-quote-form-container')) || form.parentNode;
    if (!container) return;

    var wrap = document.createElement('div');
    wrap.setAttribute('style',
      'font-family:system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;' +
      'padding:10px 0;');

    var h = document.createElement('h2');
    h.textContent = 'Thank you - your quote request has been sent';
    h.setAttribute('style', 'color:#153866;font-size:1.5rem;margin:0 0 10px;');

    var p = document.createElement('p');
    p.setAttribute('style', 'color:#333;margin:0;line-height:1.5;');
    p.textContent = 'John will review your details and come back to you shortly. ' +
      'If anything is urgent, call 01792 001350.';

    wrap.appendChild(h);
    wrap.appendChild(p);

    container.innerHTML = '';
    container.appendChild(wrap);

    try { container.scrollIntoView({ behavior: 'smooth', block: 'start' }); } catch (e) { /* non-fatal */ }
  }

  /* ---------------------------------------------------------------------
     SUBMIT
     ------------------------------------------------------------------ */
  function attach(form) {
    if (form.getAttribute('data-mp-pdf') === 'on') return;
    form.setAttribute('data-mp-pdf', 'on');

    var btn = form.querySelector('button[type="submit"], input[type="submit"]');
    var btnLabel = btn ? (btn.textContent || btn.value) : '';

    function busy(on, msg) {
      if (!btn) return;
      btn.disabled = on;
      btn.style.opacity = on ? '0.7' : '';
      btn.style.cursor = on ? 'wait' : '';
      if (btn.tagName === 'BUTTON') btn.textContent = on ? (msg || 'Sending...') : btnLabel;
      else btn.value = on ? (msg || 'Sending...') : btnLabel;
    }

    // Latched per submit attempt. Once a send has succeeded, nothing may
    // trigger the native fallback - that is what caused duplicate entries.
    var sent = false;
    var inFlight = false;

    form.addEventListener('submit', function (e) {
      e.preventDefault();

      if (sent || inFlight) { log('ignored duplicate submit'); return; }

      if (typeof form.checkValidity === 'function' && !form.checkValidity()) {
        var info = firstInvalid(form);
        log('validation blocked submit:', info && info.name);
        if (typeof form.reportValidity === 'function') form.reportValidity();
        if (info) showValidationNotice(form, info);
        return;
      }
      clearValidationNotice();

      inFlight = true;
      busy(true, 'Preparing your form...');

      var pdf = null;

      loadJsPDF()
        .then(function () {
          try {
            pdf = buildPDF(form);
          } catch (err) {
            log('PDF build failed, submitting without attachment:', err);
            pdf = null;
          }
        }, function (err) {
          log('jsPDF unavailable, submitting without attachment:', err && err.message);
          pdf = null;
        })
        .then(function () {
          busy(true, 'Sending...');

          if (CFG.setSubject) {
            var subj = form.querySelector('input[name="_subject"]');
            if (subj) {
              var proposer = proposerOf(form);
              subj.value = formTitle(form) + (proposer ? ' - ' + proposer : '') + ' - ' + todayUK();
            }
          }

          return post(form, pdf, !!pdf);
        })
        .then(function (res) {
          if (res && res.ok) { log('sent with attachment:', !!pdf); return true; }
          log('first post rejected, status', res && res.status);
          if (!pdf) return false;
          // The attachment may have been rejected. Retry without it.
          return post(form, null, false).then(function (res2) {
            log('retry without attachment, status', res2 && res2.status);
            return !!(res2 && res2.ok);
          });
        })
        .then(function (ok) {
          if (ok) { finish(); } else { hardFallback(); }
        })
        .catch(function (err) {
          log('submission error:', err);
          hardFallback();
        });

      // Success path. Errors in here must never reach the outer catch,
      // or a cosmetic failure would trigger a second submission.
      function finish() {
        sent = true;
        inFlight = false;
        try {
          busy(false);
          var next = form.querySelector('input[name="_next"]');
          if (next && next.value) { window.location.href = next.value; return; }
          showConfirmation(form);
        } catch (err) {
          log('confirmation render failed (submission was successful):', err);
        }
      }

      // Never lose a lead: fall back to a plain browser POST.
      function hardFallback() {
        if (sent) { log('fallback suppressed - already sent'); return; }
        sent = true;
        inFlight = false;
        busy(false);
        log('falling back to native submit');
        form.setAttribute('data-mp-pdf', 'off');
        HTMLFormElement.prototype.submit.call(form);
      }
    });
  }

  function post(form, pdf, withAttachment) {
    var fd = new FormData(form);
    if (withAttachment && pdf) {
      try {
        fd.append(CFG.attachmentFieldName, new File([pdf.blob], pdf.filename, { type: 'application/pdf' }));
      } catch (e) {
        fd.append(CFG.attachmentFieldName, pdf.blob, pdf.filename);
      }
    }
    return fetch(form.action, {
      method: 'POST',
      body: fd,
      headers: { Accept: 'application/json' }
    });
  }

  /* ---------------------------------------------------------------------
     INIT
     ------------------------------------------------------------------ */
  function init() {
    var forms = document.querySelectorAll(CFG.formSelector);
    if (!forms.length) return;
    each(forms, attach);
    // Warm the dependency so submitting feels instant.
    loadJsPDF().catch(function () {});
    log('attached to ' + forms.length + ' form(s)');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Expose for manual testing: MPQuotePDF.preview()
  window.MPQuotePDF = {
    config: CFG,
    preview: function () {
      var form = document.querySelector(CFG.formSelector);
      if (!form) { console.warn('[mp-pdf] no form found'); return; }
      loadJsPDF().then(function () {
        var pdf = buildPDF(form);
        window.open(URL.createObjectURL(pdf.blob), '_blank');
      }, function (err) {
        console.warn('[mp-pdf] jsPDF failed to load:', err && err.message);
      });
    }
  };
})();
