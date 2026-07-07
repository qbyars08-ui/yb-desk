/* desk.js: tiny shared helpers for yb-desk (no dependencies) */

(function (global) {
  "use strict";

  // --- HTML escaping (always escape untrusted / data-driven strings) ---
  function esc(v) {
    if (v === null || v === undefined) return "";
    return String(v)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/'/g, "&#39;");
  }

  // --- number formatting ---
  function fmtMoney(n) {
    if (typeof n !== "number" || !isFinite(n)) return "-";
    return "$" + n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPrice(n) {
    if (typeof n !== "number" || !isFinite(n)) return "-";
    return n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtPct(n) {
    if (typeof n !== "number" || !isFinite(n)) return "-";
    var s = n.toFixed(2) + "%";
    return n > 0 ? "+" + s : s;
  }
  function pctClass(n) {
    if (typeof n !== "number" || !isFinite(n) || n === 0) return "flat";
    return n > 0 ? "gain" : "loss";
  }

  // --- timestamp: "as of" formatting ---
  function fmtAsOf(iso) {
    if (!iso) return "unknown";
    var d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    try {
      return d.toLocaleString("en-US", {
        year: "numeric", month: "short", day: "numeric",
        hour: "numeric", minute: "2-digit"
      });
    } catch (e) {
      return d.toISOString();
    }
  }

  // --- fetch JSON with error handling ---
  function loadJSON(path) {
    return fetch(path, { cache: "no-store" }).then(function (res) {
      if (!res.ok) throw new Error("HTTP " + res.status + " for " + path);
      return res.json();
    });
  }

  // --- tiny markdown -> html (headings, bold, lists, paragraphs) ---
  // Escapes HTML first, then applies a minimal subset. ~40 lines.
  function mdToHtml(md) {
    var safe = esc(md).replace(/\r\n/g, "\n");
    var lines = safe.split("\n");
    var out = [];
    var listOpen = false;
    function closeList() {
      if (listOpen) { out.push("</ul>"); listOpen = false; }
    }
    function inline(t) {
      // bold **x** then italic *x* (bold first to avoid clobber)
      t = t.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
      t = t.replace(/\*([^*]+)\*/g, "<em>$1</em>");
      t = t.replace(/`([^`]+)`/g, "<code>$1</code>");
      return t;
    }
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      var trimmed = line.trim();
      if (trimmed === "") { closeList(); continue; }
      var h = trimmed.match(/^(#{1,3})\s+(.*)$/);
      if (h) {
        closeList();
        var lvl = h[1].length;
        out.push("<h" + lvl + ">" + inline(h[2]) + "</h" + lvl + ">");
        continue;
      }
      var li = trimmed.match(/^[-*]\s+(.*)$/);
      if (li) {
        if (!listOpen) { out.push("<ul>"); listOpen = true; }
        out.push("<li>" + inline(li[1]) + "</li>");
        continue;
      }
      closeList();
      out.push("<p>" + inline(trimmed) + "</p>");
    }
    closeList();
    return out.join("\n");
  }

  // --- footer disclaimer injection (consistent across pages) ---
  function mountFooter(el) {
    if (!el) return;
    el.innerHTML =
      '<div class="wrap">' +
        '<div class="disclaimer"><b>Not investment advice. Your money, your call.</b></div>' +
        '<div class="links">' +
          '<a href="index.html">Desk</a>' +
          '<a href="about.html">How it works</a>' +
          '<a href="https://github.com/qbyars08-ui/yb-desk" target="_blank" rel="noopener">GitHub</a>' +
        '</div>' +
      '</div>';
  }

  global.Desk = {
    esc: esc,
    fmtMoney: fmtMoney,
    fmtPrice: fmtPrice,
    fmtPct: fmtPct,
    pctClass: pctClass,
    fmtAsOf: fmtAsOf,
    loadJSON: loadJSON,
    mdToHtml: mdToHtml,
    mountFooter: mountFooter
  };
})(window);
