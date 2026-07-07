/* members.js: yb-desk Members page. OTP sign-in (Supabase), synced holdings,
   weekly brief, alerts. Raw fetch only, no dependencies. */

(function () {
  "use strict";
  var D = window.Desk;

  // ---- Config ----
  var SUPABASE_URL = "https://qfkiijoimekbgfruqfpd.supabase.co";
  var SUPABASE_ANON_KEY = "sb_publishable_9EURziwOccle5cR5WAWAAA_DMdG5bbW";
  var API_BASE = "https://youngbullinvests.com";
  var SESSION_KEY = "ybdesk.session.v1";
  var PORTFOLIO_LS_KEY = "ybdesk.portfolio.v1";
  var TICKER_RE = /^[A-Z][A-Z0-9.\-]{0,11}$/;
  var QUOTES_API = API_BASE + "/api/quotes?tickers=";
  var REFRESH_SKEW_MS = 5 * 60 * 1000; // refresh if expiring within 5 min

  var state = {
    session: null,      // {access_token, refresh_token, expires_at, email}
    premium: null,       // bool | null (unknown yet)
    holdings: [],
    liveQuotes: {},
    quotesTried: {},
    book: null           // Quinn's book (data/book.json), for sleeve/layer lookups
  };

  D.mountFooter(document.getElementById("site-footer"));

  D.loadJSON("data/book.json").then(function (book) {
    state.book = book;
    renderHoldings();
  }).catch(function () { /* analytics falls back to "outside the book" for all names */ });

  // ============ SESSION STORAGE ============
  function loadSession() {
    try {
      var raw = localStorage.getItem(SESSION_KEY);
      if (!raw) return null;
      var s = JSON.parse(raw);
      if (!s || typeof s !== "object") return null;
      if (typeof s.access_token !== "string" || typeof s.refresh_token !== "string") return null;
      return s;
    } catch (e) { return null; }
  }
  function saveSession(s) {
    try { localStorage.setItem(SESSION_KEY, JSON.stringify(s)); }
    catch (e) { /* storage full or blocked; session just won't persist */ }
  }
  function clearSession() {
    try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* ignore */ }
    state.session = null;
    state.premium = null;
  }

  function expiresAtMs(session) {
    if (typeof session.expires_at === "number") {
      // Supabase expires_at is seconds since epoch
      return session.expires_at * 1000;
    }
    return 0;
  }

  // ============ SUPABASE AUTH (raw fetch) ============
  function authHeaders(extra) {
    var h = { "apikey": SUPABASE_ANON_KEY, "Content-Type": "application/json" };
    if (extra) for (var k in extra) h[k] = extra[k];
    return h;
  }

  function requestOtp(email) {
    return fetch(SUPABASE_URL + "/auth/v1/otp", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ email: email, create_user: true })
    }).then(function (res) {
      if (res.status === 429) {
        return res.json().catch(function () { return {}; }).then(function () {
          throw new Error("Too many attempts. Wait a few minutes and try again.");
        });
      }
      if (!res.ok) {
        return res.json().catch(function () { return {}; }).then(function (j) {
          throw new Error((j && (j.error_description || j.msg || j.message)) || ("Could not send the code (HTTP " + res.status + ")."));
        });
      }
      return true;
    });
  }

  function verifyOtp(email, token) {
    return fetch(SUPABASE_URL + "/auth/v1/verify", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ type: "email", email: email, token: token })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok || !j || !j.access_token) {
          throw new Error((j && (j.error_description || j.msg || j.message)) || "That code did not work. Check it and try again.");
        }
        return j;
      });
    }).then(function (j) {
      var session = {
        access_token: j.access_token,
        refresh_token: j.refresh_token,
        expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
        email: (j.user && j.user.email) || email
      };
      saveSession(session);
      state.session = session;
      return session;
    });
  }

  function refreshSession(session) {
    return fetch(SUPABASE_URL + "/auth/v1/token?grant_type=refresh_token", {
      method: "POST",
      headers: authHeaders(),
      body: JSON.stringify({ refresh_token: session.refresh_token })
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (j) {
        if (!res.ok || !j || !j.access_token) throw new Error("refresh failed");
        return j;
      });
    }).then(function (j) {
      var next = {
        access_token: j.access_token,
        refresh_token: j.refresh_token || session.refresh_token,
        expires_at: j.expires_at || (Math.floor(Date.now() / 1000) + (j.expires_in || 3600)),
        email: (j.user && j.user.email) || session.email
      };
      saveSession(next);
      state.session = next;
      return next;
    });
  }

  // Ensures state.session is valid (refreshing if near expiry). Rejects (and
  // clears session) if there is no session or refresh fails.
  function ensureFreshSession() {
    var s = state.session || loadSession();
    if (!s) return Promise.reject(new Error("no session"));
    var msLeft = expiresAtMs(s) - Date.now();
    if (msLeft > REFRESH_SKEW_MS) {
      state.session = s;
      return Promise.resolve(s);
    }
    return refreshSession(s).catch(function (e) {
      clearSession();
      throw e;
    });
  }

  function signOut() {
    clearSession();
    renderSignedOut();
    hideMemberSections();
  }

  // ============ MEMBER API HELPERS ============
  // Wraps a fetch to a member API endpoint: ensures a fresh session, attaches
  // the bearer token, and handles 401 / bad JSON / network failure uniformly.
  function memberFetch(path, opts) {
    opts = opts || {};
    return ensureFreshSession().then(function (session) {
      var headers = {};
      if (opts.headers) { for (var k in opts.headers) headers[k] = opts.headers[k]; }
      headers["Authorization"] = "Bearer " + session.access_token;
      if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
      return fetch(API_BASE + path, {
        method: opts.method || "GET",
        headers: headers,
        body: opts.body
      });
    }).then(function (res) {
      if (res.status === 401) {
        clearSession();
        renderSignedOut();
        hideMemberSections();
        throw new Error("Your session expired. Sign in again.");
      }
      return res.text().then(function (text) {
        var json = null;
        try { json = text ? JSON.parse(text) : null; } catch (e) { /* not JSON */ }
        if (!res.ok || !json || json.ok === false) {
          var msg = (json && (json.error || json.message)) || ("The desk could not read that (HTTP " + res.status + ").");
          throw new Error(msg);
        }
        return json;
      });
    }).catch(function (e) {
      if (e instanceof TypeError) throw new Error("The desk could not reach the member API.");
      throw e;
    });
  }

  // ============ SIGN-IN UI ============
  function renderSignedOut() {
    var wrap = document.getElementById("signin-wrap");
    document.getElementById("signin-note").textContent = "";
    wrap.innerHTML =
      '<div class="signin-box">' +
        '<div class="step-label" id="signin-step-label">Step 1 of 2</div>' +
        '<div id="signin-msg"></div>' +
        '<form id="email-form" autocomplete="off">' +
          '<div class="field"><label for="si-email">Email</label>' +
          '<input id="si-email" type="email" name="email" placeholder="you@example.com" required></div>' +
          '<button type="submit" class="btn">Send me a code</button>' +
        '</form>' +
      '</div>';

    document.getElementById("email-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var emailInput = document.getElementById("si-email");
      var email = String(emailInput.value || "").trim();
      if (!email) return;
      var btn = e.target.querySelector("button");
      setSigninMsg("");
      btn.disabled = true;
      btn.textContent = "Sending...";
      requestOtp(email).then(function () {
        renderCodeStep(email);
      }).catch(function (err) {
        setSigninMsg(D.esc(err.message), "err");
        btn.disabled = false;
        btn.textContent = "Send me a code";
      });
    });
  }

  function renderCodeStep(email) {
    var wrap = document.getElementById("signin-wrap");
    wrap.innerHTML =
      '<div class="signin-box">' +
        '<div class="step-label">Step 2 of 2</div>' +
        '<div id="signin-msg"></div>' +
        '<p class="hint">Check your email for a sign-in code. Sent to <b>' + D.esc(email) + '</b>.</p>' +
        '<form id="code-form" autocomplete="off">' +
          '<div class="field"><label for="si-code">Sign-in code</label>' +
          '<input id="si-code" name="code" inputmode="numeric" maxlength="10" placeholder="12345678" required></div>' +
          '<button type="submit" class="btn">Verify</button>' +
        '</form>' +
        '<button type="button" class="btn ghost" id="resend-btn" style="margin-top:8px">Use a different email</button>' +
      '</div>';

    document.getElementById("resend-btn").addEventListener("click", function () { renderSignedOut(); });

    document.getElementById("code-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var code = String(document.getElementById("si-code").value || "").trim();
      if (!code) return;
      var btn = e.target.querySelector("button");
      setSigninMsg("");
      btn.disabled = true;
      btn.textContent = "Verifying...";
      verifyOtp(email, code).then(function () {
        boot();
      }).catch(function (err) {
        setSigninMsg(D.esc(err.message), "err");
        btn.disabled = false;
        btn.textContent = "Verify";
      });
    });
  }

  function renderSignedIn(session) {
    var wrap = document.getElementById("signin-wrap");
    wrap.innerHTML =
      '<div class="signin-box">' +
        '<div class="signin-status">' +
          '<span class="who">Signed in as <span class="gold">' + D.esc(session.email) + '</span></span>' +
          '<button type="button" class="btn ghost" id="signout-btn">Sign out</button>' +
        '</div>' +
      '</div>';
    document.getElementById("signout-btn").addEventListener("click", signOut);
  }

  function setSigninMsg(html, kind) {
    var el = document.getElementById("signin-msg");
    if (!el) return;
    if (!html) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="msg ' + (kind === "err" ? "err" : "ok") + '">' + html + '</div>';
  }

  // ============ MEMBER STATUS ============
  function hideMemberSections() {
    document.getElementById("locked-section").hidden = true;
    document.getElementById("holdings-section").hidden = true;
    document.getElementById("brief-section").hidden = true;
    document.getElementById("alerts-section").hidden = true;
  }

  function checkPremium() {
    return memberFetch("/api/me/premium").then(function (j) {
      state.premium = !!j.premium;
      return state.premium;
    });
  }

  function gateOnPremium() {
    hideMemberSections();
    if (state.premium) {
      document.getElementById("holdings-section").hidden = false;
      document.getElementById("brief-section").hidden = false;
      document.getElementById("alerts-section").hidden = false;
      loadHoldings();
      loadBrief();
      wireGenerateBrief();
      loadAlerts();
    } else {
      document.getElementById("locked-section").hidden = false;
    }
  }

  // ============ PRICING (shared with index.html's approach) ============
  function priceFor(ticker) {
    var lq = state.liveQuotes[ticker];
    return (lq && typeof lq.price === "number") ? lq : null;
  }

  function fetchMissingQuotes(tickers, onDone) {
    var missing = tickers.filter(function (t) {
      return TICKER_RE.test(t) && !priceFor(t) && !state.quotesTried[t];
    });
    if (!missing.length) { if (onDone) onDone(); return; }
    missing.forEach(function (t) { state.quotesTried[t] = true; });

    fetch(QUOTES_API + encodeURIComponent(missing.slice(0, 60).join(",")))
      .then(function (res) { return res.ok ? res.json() : null; })
      .then(function (data) {
        if (data && data.ok && data.quotes) {
          Object.keys(data.quotes).forEach(function (t) {
            var q = data.quotes[t];
            if (q && typeof q.price === "number") state.liveQuotes[t] = q;
          });
        }
        if (onDone) onDone();
      })
      .catch(function () { if (onDone) onDone(); });
  }

  // ============ YOUR BOOK, SYNCED ============
  function showHoldingsMsg(html, kind) {
    var el = document.getElementById("holdings-msg");
    if (!html) { el.innerHTML = ""; return; }
    el.innerHTML = '<div class="msg ' + (kind === "err" ? "err" : "ok") + '">' + html + '</div>';
  }

  function loadHoldings() {
    memberFetch("/api/me/holdings").then(function (j) {
      state.holdings = Array.isArray(j.holdings) ? j.holdings : [];
      document.getElementById("holdings-asof").textContent = "as of " + D.fmtAsOf(new Date().toISOString());
      renderHoldings();
      fetchMissingQuotes(state.holdings.map(function (r) { return String(r.ticker).toUpperCase(); }), renderHoldings);
    }).catch(function (e) {
      document.getElementById("holdings-body").innerHTML =
        '<tr><td class="l" colspan="9"><span class="empty">' + D.esc(e.message) + '</span></td></tr>';
    });
  }

  function renderHoldings() {
    var body = document.getElementById("holdings-body");
    var foot = document.getElementById("holdings-foot");
    var emptyEl = document.getElementById("holdings-empty");
    var tableScroll = document.querySelector("#holdings-section .table-scroll");
    var rows = state.holdings;

    var analyticsRows = rows.map(function (r) {
      return { ticker: String(r.ticker).toUpperCase(), shares: Number(r.shares), costBasis: Number(r.cost_basis) };
    });

    if (!rows.length) {
      body.innerHTML = "";
      foot.innerHTML = "";
      tableScroll.style.display = "none";
      emptyEl.innerHTML = '<div class="empty">No synced holdings yet. Add one above, or import your local desk.</div>';
      D.renderAnalytics(document.getElementById("m-analytics"), analyticsRows, priceFor, state.book);
      return;
    }
    tableScroll.style.display = "";
    emptyEl.innerHTML = "";

    var totValue = 0, totCost = 0, haveAnyPrice = false;
    var html = rows.map(function (r, idx) {
      var t = String(r.ticker).toUpperCase();
      var shares = Number(r.shares);
      var cost = Number(r.cost_basis);
      var q = priceFor(t);
      var lastCell, dayCell, mvCell, plCell, plPctCell;
      if (q) {
        haveAnyPrice = true;
        var mv = shares * q.price;
        var costTotal = shares * cost;
        var pl = mv - costTotal;
        var plPct = costTotal > 0 ? (pl / costTotal) * 100 : 0;
        totValue += mv; totCost += costTotal;
        lastCell = D.fmtPrice(q.price);
        dayCell = '<span class="' + D.pctClass(q.changePct) + '">' + D.fmtPct(q.changePct) + '</span>';
        mvCell = D.fmtMoney(mv);
        plCell = '<span class="' + D.pctClass(pl) + '">' + D.fmtMoney(pl) + '</span>';
        plPctCell = '<span class="' + D.pctClass(plPct) + '">' + D.fmtPct(plPct) + '</span>';
      } else {
        lastCell = dayCell = mvCell = plCell = plPctCell = '<span class="faint">-</span>';
      }
      return '<tr>' +
        '<td class="l"><span class="ticker">' + D.esc(t) + '</span></td>' +
        '<td>' + D.fmtPrice(shares) + '</td>' +
        '<td>' + D.fmtPrice(cost) + '</td>' +
        '<td>' + lastCell + '</td>' +
        '<td>' + dayCell + '</td>' +
        '<td>' + mvCell + '</td>' +
        '<td>' + plCell + '</td>' +
        '<td>' + plPctCell + '</td>' +
        '<td><button type="button" class="btn danger" data-h-remove="' + idx + '" title="Remove">&times;</button></td>' +
        '</tr>';
    }).join("");
    body.innerHTML = html;

    if (haveAnyPrice) {
      var totPl = totValue - totCost;
      var totPlPct = totCost > 0 ? (totPl / totCost) * 100 : 0;
      foot.innerHTML = '<tr class="tot">' +
        '<td class="l">Total</td><td></td><td></td><td></td><td></td>' +
        '<td>' + D.fmtMoney(totValue) + '</td>' +
        '<td><span class="' + D.pctClass(totPl) + '">' + D.fmtMoney(totPl) + '</span></td>' +
        '<td><span class="' + D.pctClass(totPlPct) + '">' + D.fmtPct(totPlPct) + '</span></td>' +
        '<td></td></tr>';
    } else {
      foot.innerHTML = "";
    }

    D.renderAnalytics(document.getElementById("m-analytics"), analyticsRows, priceFor, state.book);

    body.querySelectorAll("button[data-h-remove]").forEach(function (btn) {
      btn.addEventListener("click", function () {
        var i = parseInt(btn.getAttribute("data-h-remove"), 10);
        var row = state.holdings[i];
        if (!row) return;
        removeHolding(row.ticker);
      });
    });
  }

  function validateHolding(ticker, shares, cost) {
    var t = String(ticker || "").trim().toUpperCase();
    if (!TICKER_RE.test(t)) return { error: "Ticker \"" + D.esc(t || ticker) + "\" is not valid." };
    var sh = Number(shares);
    if (!isFinite(sh) || sh <= 0) return { error: "Shares must be a number greater than 0." };
    var cb = Number(cost);
    if (!isFinite(cb) || cb < 0) return { error: "Cost basis must be a number of 0 or more." };
    return { row: { ticker: t, shares: sh, cost_basis: cb } };
  }

  function wireHoldingsAddForm() {
    var form = document.getElementById("holdings-add-form");
    form.addEventListener("submit", function (e) {
      e.preventDefault();
      showHoldingsMsg("");
      var v = validateHolding(
        document.getElementById("h-ticker").value,
        document.getElementById("h-shares").value,
        document.getElementById("h-cost").value
      );
      if (v.error) { showHoldingsMsg(v.error, "err"); return; }
      memberFetch("/api/me/holdings", {
        method: "POST",
        body: JSON.stringify({ rows: [v.row] })
      }).then(function (j) {
        var imported = (typeof j.imported === "number") ? j.imported : 1;
        var errs = Array.isArray(j.errors) ? j.errors : [];
        if (imported > 0) {
          form.reset();
          document.getElementById("h-ticker").focus();
        }
        if (errs.length) {
          showHoldingsMsg("Could not add: " + errs.map(D.esc).join("; "), "err");
        } else {
          showHoldingsMsg("Added.", "ok");
        }
        loadHoldings();
      }).catch(function (err) {
        showHoldingsMsg(D.esc(err.message), "err");
      });
    });
  }

  function removeHolding(ticker) {
    memberFetch("/api/me/holdings?ticker=" + encodeURIComponent(ticker), { method: "DELETE" })
      .then(function () { loadHoldings(); })
      .catch(function (err) { showHoldingsMsg(D.esc(err.message), "err"); });
  }

  function loadLocalDesk() {
    try {
      var raw = localStorage.getItem(PORTFOLIO_LS_KEY);
      if (!raw) return [];
      var arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr.filter(function (r) {
        return r && typeof r.ticker === "string" && typeof r.shares === "number" && typeof r.costBasis === "number";
      });
    } catch (e) { return []; }
  }

  function wireImportLocalButton() {
    document.getElementById("import-local-btn").addEventListener("click", function () {
      var local = loadLocalDesk();
      if (!local.length) {
        showHoldingsMsg("Your local desk (on this browser) has no positions to import.", "err");
        return;
      }
      var ok = window.confirm("Import " + local.length + " position" + (local.length === 1 ? "" : "s") + " from your local desk into your synced account? This adds to, and does not remove, anything already synced.");
      if (!ok) return;
      var rows = local.map(function (r) {
        return { ticker: String(r.ticker).toUpperCase(), shares: Number(r.shares), cost_basis: Number(r.costBasis) };
      });
      memberFetch("/api/me/holdings", {
        method: "POST",
        body: JSON.stringify({ rows: rows })
      }).then(function (j) {
        var imported = (typeof j.imported === "number") ? j.imported : rows.length;
        var errs = Array.isArray(j.errors) ? j.errors : [];
        var msg = "Imported " + imported + " row" + (imported === 1 ? "" : "s") + ".";
        if (errs.length) {
          msg += " Skipped " + errs.length + ":<ul>" + errs.slice(0, 25).map(function (e) { return "<li>" + D.esc(String(e)) + "</li>"; }).join("") + "</ul>";
        }
        showHoldingsMsg(msg, errs.length ? "err" : "ok");
        loadHoldings();
      }).catch(function (err) {
        showHoldingsMsg(D.esc(err.message), "err");
      });
    });
  }

  // ============ YOUR WEEKLY BRIEF ============
  function renderBrief(wrap, brief) {
    var meta = brief.generated_at ? '<div class="brief-meta">generated ' + D.esc(D.fmtAsOf(brief.generated_at)) + '</div>' : "";
    wrap.innerHTML = meta + '<div class="brief-body">' + D.mdToHtml(brief.content_md || "") + '</div>';
  }

  function loadBrief() {
    var wrap = document.getElementById("brief-wrap");
    memberFetch("/api/me/premium-brief").then(function (j) {
      var brief = j.brief;
      if (!brief) {
        wrap.innerHTML = '<div class="empty">No brief yet. Hit the button above and the desk writes one from your positions right now.</div>';
        return;
      }
      renderBrief(wrap, brief);
    }).catch(function (e) {
      wrap.innerHTML = '<div class="empty">' + D.esc(e.message) + '</div>';
    });
  }

  function wireGenerateBrief() {
    var btn = document.getElementById("brief-generate-btn");
    if (!btn) return;
    btn.addEventListener("click", function () {
      var wrap = document.getElementById("brief-wrap");
      btn.disabled = true;
      btn.textContent = "The desk is working...";
      memberFetch("/api/me/generate-brief", { method: "POST" }).then(function (j) {
        if (j.brief) renderBrief(wrap, j.brief);
      }).catch(function (e) {
        wrap.innerHTML = '<div class="empty">' + D.esc(e.message) + '</div>' + wrap.innerHTML;
      }).then(function () {
        btn.disabled = false;
        btn.textContent = "Generate my brief now";
      });
    });
  }

  // ============ YOUR ALERTS ============
  function alertSummary(a) {
    if (a.summary) return String(a.summary);
    if (a.payload && typeof a.payload === "object") {
      try { return JSON.stringify(a.payload); } catch (e) { /* fall through */ }
    }
    return a.payload ? String(a.payload) : "";
  }

  function loadAlerts() {
    var wrap = document.getElementById("alerts-wrap");
    memberFetch("/api/me/premium-alerts").then(function (j) {
      var alerts = Array.isArray(j.alerts) ? j.alerts.slice() : [];
      if (!alerts.length) {
        wrap.innerHTML = '<div class="empty">No alerts yet. The watchdog runs daily.</div>';
        return;
      }
      alerts.sort(function (a, b) { return String(b.created_at || "").localeCompare(String(a.created_at || "")); });
      wrap.innerHTML = '<div class="alert-list">' + alerts.map(function (a) {
        return '<div class="alert-item">' +
          '<span class="ticker">' + D.esc(a.ticker || "-") + '</span>' +
          '<span class="type">' + D.esc(a.alert_type || "alert") + '</span>' +
          '<span class="summary">' + D.esc(alertSummary(a)) + '</span>' +
          '<span class="when">' + D.esc(D.fmtAsOf(a.created_at)) + '</span>' +
          '</div>';
      }).join("") + '</div>';
    }).catch(function (e) {
      wrap.innerHTML = '<div class="empty">' + D.esc(e.message) + '</div>';
    });
  }

  // ============ BOOT ============
  function boot() {
    var session = loadSession();
    if (!session) {
      state.session = null;
      renderSignedOut();
      hideMemberSections();
      return;
    }
    ensureFreshSession().then(function (fresh) {
      renderSignedIn(fresh);
      return checkPremium();
    }).then(function () {
      gateOnPremium();
    }).catch(function () {
      renderSignedOut();
      hideMemberSections();
    });
  }

  wireHoldingsAddForm();
  wireImportLocalButton();
  boot();
})();
