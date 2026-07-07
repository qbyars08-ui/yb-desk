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

  // --- Desk Analytics: pure math (no DOM) ---
  // rows: [{ticker, shares, costBasis}]
  // priceFor(ticker) -> {price, changePct} | falsy
  // book: {positions: [{t, layer, ...}]} | null
  // returns {alloc, buckets, flags, overlap}
  function computeAnalytics(rows, priceFor, book) {
    var list = Array.isArray(rows) ? rows : [];
    var bookPositions = (book && Array.isArray(book.positions)) ? book.positions : [];
    var layerByTicker = {};
    bookPositions.forEach(function (p) {
      if (p && p.t) layerByTicker[String(p.t).toUpperCase()] = p.layer || "unlabeled";
    });
    var bookTickerSet = {};
    bookPositions.forEach(function (p) { if (p && p.t) bookTickerSet[String(p.t).toUpperCase()] = true; });
    var bookCount = Object.keys(bookTickerSet).length;

    var items = list.map(function (r) {
      var ticker = String(r.ticker).toUpperCase();
      var shares = Number(r.shares);
      var cost = Number(r.costBasis);
      var q = priceFor ? priceFor(ticker) : null;
      var hasPrice = !!(q && typeof q.price === "number");
      var value = hasPrice ? shares * q.price : shares * cost;
      return { ticker: ticker, value: value, hasPrice: hasPrice };
    });

    var totalValue = items.reduce(function (sum, it) { return sum + it.value; }, 0);

    var alloc = items.map(function (it) {
      return {
        ticker: it.ticker,
        value: it.value,
        pct: totalValue > 0 ? (it.value / totalValue) * 100 : 0,
        hasPrice: it.hasPrice
      };
    }).sort(function (a, b) { return b.value - a.value; });

    var bucketMap = {};
    items.forEach(function (it) {
      var name = layerByTicker[it.ticker] || "outside the book";
      if (!bucketMap[name]) bucketMap[name] = 0;
      bucketMap[name] += it.value;
    });
    var buckets = Object.keys(bucketMap).map(function (name) {
      var value = bucketMap[name];
      return { name: name, value: value, pct: totalValue > 0 ? (value / totalValue) * 100 : 0 };
    }).sort(function (a, b) { return b.value - a.value; });

    var flags = [];
    alloc.forEach(function (a) {
      if (a.pct >= 25) {
        flags.push(a.ticker + " is " + Math.round(a.pct) + "% of your desk.");
      }
    });
    buckets.forEach(function (b) {
      if (b.pct >= 40) {
        flags.push('"' + b.name + '" is ' + Math.round(b.pct) + "% of your desk.");
      }
    });
    var noQuoteCount = items.filter(function (it) { return !it.hasPrice; }).length;
    if (noQuoteCount > 0) {
      flags.push(noQuoteCount + " position" + (noQuoteCount === 1 ? "" : "s") + " on your desk " +
        (noQuoteCount === 1 ? "has" : "have") + " no live quote.");
    }
    if (!flags.length) {
      flags.push("No concentration flags at these weights.");
    }

    var heldTickers = {};
    items.forEach(function (it) { if (bookTickerSet[it.ticker]) heldTickers[it.ticker] = true; });
    var heldCount = Object.keys(heldTickers).length;
    var overlapValue = items.reduce(function (sum, it) {
      return sum + (bookTickerSet[it.ticker] ? it.value : 0);
    }, 0);
    var overlap = {
      heldCount: heldCount,
      bookCount: bookCount,
      pctOfDeskValue: totalValue > 0 ? (overlapValue / totalValue) * 100 : 0
    };

    return { alloc: alloc, buckets: buckets, flags: flags, overlap: overlap };
  }

  // --- Desk Analytics: renderer ---
  // containerEl: element to render into (hidden entirely when rows is empty)
  // rows: [{ticker, shares, costBasis}]
  // priceFor(ticker) -> {price, changePct} | falsy
  // bookPositions: the book object (see computeAnalytics)
  function barRowHtml(label, value, pct, extra) {
    var pctLabel = (typeof pct === "number" && isFinite(pct)) ? pct.toFixed(1) + "%" : "-";
    return '<div class="analytics-bar-row">' +
      '<div class="analytics-bar-label">' + esc(label) + (extra || "") + '</div>' +
      '<div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:' + Math.max(0, Math.min(100, pct || 0)) + '%"></div></div>' +
      '<div class="analytics-bar-pct mono">' + pctLabel + '</div>' +
      '</div>';
  }

  function renderAnalytics(containerEl, rows, priceFor, bookPositions) {
    if (!containerEl) return;
    var list = Array.isArray(rows) ? rows : [];
    if (!list.length) {
      containerEl.hidden = true;
      containerEl.innerHTML = "";
      return;
    }
    containerEl.hidden = false;

    var a = computeAnalytics(list, priceFor, bookPositions);

    var allocHtml = a.alloc.map(function (it) {
      var extra = it.hasPrice ? "" : ' <span class="faint">(no quote, cost basis used)</span>';
      return barRowHtml(it.ticker, it.value, it.pct, extra);
    }).join("");

    var bucketsHtml = a.buckets.map(function (b) {
      return barRowHtml(b.name, b.value, b.pct);
    }).join("");

    var flagsHtml = '<ul class="analytics-flags">' + a.flags.map(function (f) {
      return "<li>" + esc(f) + "</li>";
    }).join("") + "</ul>";

    var overlapPct = a.overlap.pctOfDeskValue;
    var overlapHtml =
      '<div class="analytics-overlap-line">You hold ' + a.overlap.heldCount + " of the " + a.overlap.bookCount +
      " names in Quinn's book (" + (isFinite(overlapPct) ? overlapPct.toFixed(1) : "0.0") +
      "% of your desk value overlaps).</div>" +
      '<div class="analytics-bar-track"><div class="analytics-bar-fill" style="width:' +
      Math.max(0, Math.min(100, overlapPct || 0)) + '%"></div></div>';

    containerEl.innerHTML =
      '<div class="analytics-block">' +
        '<h3 class="analytics-h">Allocation</h3>' +
        '<div class="analytics-bars">' + allocHtml + '</div>' +
      '</div>' +
      '<div class="analytics-block">' +
        '<h3 class="analytics-h">Sleeve / layer split</h3>' +
        '<div class="analytics-bars">' + bucketsHtml + '</div>' +
      '</div>' +
      '<div class="analytics-block">' +
        '<h3 class="analytics-h">Concentration flags</h3>' +
        flagsHtml +
      '</div>' +
      '<div class="analytics-block">' +
        '<h3 class="analytics-h">Overlap with the book</h3>' +
        overlapHtml +
      '</div>';
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
    mountFooter: mountFooter,
    computeAnalytics: computeAnalytics,
    renderAnalytics: renderAnalytics
  };
})(window);
