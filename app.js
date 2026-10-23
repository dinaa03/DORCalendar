/* =====================================================================
   Bridgewater PTC – Site Visibility Calendar
   ---------------------------------------------------------------------
   SETTINGS: paste your Supabase values below (Project Settings > API).
   Leave them blank to run in DEMO mode (passkey: demo, data on this
   device only). See README.md for the database setup.
   ===================================================================== */
const SETTINGS = {
  SUPABASE_URL: "",        // e.g. "https://abcdxyz.supabase.co"
  SUPABASE_ANON_KEY: "",   // the "anon public" key (never the service_role key)
  REFRESH_SECONDS: 60      // how often the TV pulls new data
};

(() => {
  "use strict";

  const CFG = SETTINGS;
  const DEMO = !CFG.SUPABASE_URL || !CFG.SUPABASE_ANON_KEY;
  const TOKEN_KEY = "bvc_session_token";
  const TYPES = {
    event:      { label: "EVENT",      add: "ADD EVENT" },
    contractor: { label: "CONTRACTOR", add: "ADD CONTRACTOR" },
    pto:        { label: "PTO / OOO",  add: "ADD PTO / OOO" }
  };
  const WD = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"];
  const WD_LONG = ["MONDAY", "TUESDAY", "WEDNESDAY", "THURSDAY", "FRIDAY", "SATURDAY", "SUNDAY"];

  const state = { view: "month", filter: "all", focus: today(), entries: [], token: null };

  // ---------- Date helpers ----------
  const pad = n => String(n).padStart(2, "0");
  function today() { const d = new Date(); return new Date(d.getFullYear(), d.getMonth(), d.getDate()); }
  const ymd = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
  const parse = s => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d); };
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const mondayOf = d => addDays(d, -((d.getDay() + 6) % 7));
  const sameDay = (a, b) => ymd(a) === ymd(b);
  const fmtTime = t => {
    if (!t) return "";
    const [h, m] = t.split(":").map(Number);
    return `${h % 12 || 12}:${pad(m)} ${h >= 12 ? "PM" : "AM"}`;
  };
  const fmtShort = d => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const fmtLong = d => d.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

  const isAllDay = e => e.all_day || !e.start_time;
  function timeText(e) {
    if (isAllDay(e)) return "All day";
    return e.end_time ? `${fmtTime(e.start_time)} – ${fmtTime(e.end_time)}` : fmtTime(e.start_time);
  }
  function dateRangeText(e) {
    const s = parse(e.start_date), en = parse(e.end_date);
    return e.start_date === e.end_date ? fmtLong(s) : `${fmtShort(s)} – ${fmtShort(en)}, ${en.getFullYear()}`;
  }
  const displayTitle = e => (e.type === "pto" ? `${e.title} OOO` : e.title);

  // ---------- Data API ----------
  const API = {
    async rpc(fn, args) {
      const r = await fetch(`${CFG.SUPABASE_URL.replace(/\/$/, "")}/rest/v1/rpc/${fn}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", apikey: CFG.SUPABASE_ANON_KEY, Authorization: `Bearer ${CFG.SUPABASE_ANON_KEY}` },
        body: JSON.stringify(args)
      });
      const txt = await r.text();
      const body = txt ? JSON.parse(txt) : null;
      if (!r.ok) {
        const err = new Error((body && body.message) || r.statusText);
        if (err.message.includes("INVALID_SESSION")) err.invalidSession = true;
        throw err;
      }
      return body;
    },
    // Demo storage (only used when Supabase is not configured)
    demoAll() { try { return JSON.parse(localStorage.getItem("bvc_demo_entries")) || []; } catch { return []; } },
    demoSet(list) { localStorage.setItem("bvc_demo_entries", JSON.stringify(list)); },

    async login(passkey) {
      if (DEMO) return passkey === "demo" ? "demo-token" : null;
      return this.rpc("app_login", { p_passkey: passkey });
    },
    async check(token) { return DEMO ? token === "demo-token" : this.rpc("app_check", { p_token: token }); },
    async logout(token) { if (!DEMO) { try { await this.rpc("app_logout", { p_token: token }); } catch {} } },
    async list(from, to) {
      if (DEMO) return this.demoAll().filter(e => e.start_date <= to && e.end_date >= from);
      return this.rpc("app_list", { p_token: state.token, p_from: from, p_to: to });
    },
    async save(entry) {
      if (DEMO) {
        const all = this.demoAll();
        if (entry.id) { const i = all.findIndex(x => x.id === entry.id); if (i >= 0) all[i] = entry; }
        else { entry.id = (crypto.randomUUID ? crypto.randomUUID() : String(Date.now())); all.push(entry); }
        this.demoSet(all); return entry;
      }
      return this.rpc("app_save", { p_token: state.token, p_entry: entry });
    },
    async remove(id) {
      if (DEMO) { this.demoSet(this.demoAll().filter(x => x.id !== id)); return; }
      return this.rpc("app_delete", { p_token: state.token, p_id: id });
    }
  };

  // ---------- DOM ----------
  const $ = id => document.getElementById(id);
  const els = {
    login: $("login"), loginForm: $("loginForm"), passkey: $("passkey"), loginError: $("loginError"), loginBtn: $("loginBtn"),
    app: $("app"), cal: $("calendar"), period: $("periodLabel"), modal: $("modal"), modalCard: $("modalCard"),
    todayBox: $("todayBox"), todayBody: $("todayBody"), todayCounts: $("todayCounts"), status: $("status")
  };

  // ---------- Auth ----------
  async function boot() {
    if (DEMO) $("demoBanner").classList.remove("hidden");
    const saved = localStorage.getItem(TOKEN_KEY);
    if (saved) {
      try { if (await API.check(saved)) { state.token = saved; return enterApp(); } }
      catch (e) { if (!e.invalidSession) { state.token = saved; return enterApp(); } } // network blip: keep TV signed in
      localStorage.removeItem(TOKEN_KEY);
    }
    showLogin();
  }
  function showLogin() {
    els.app.classList.add("hidden"); els.login.classList.remove("hidden");
    els.passkey.value = ""; setTimeout(() => els.passkey.focus(), 50);
  }
  els.loginForm.addEventListener("submit", async ev => {
    ev.preventDefault();
    els.loginError.textContent = ""; els.loginBtn.disabled = true; els.loginBtn.textContent = "Checking…";
    try {
      const token = await API.login(els.passkey.value);
      if (!token) { els.loginError.textContent = "Incorrect passkey."; return; }
      state.token = token; localStorage.setItem(TOKEN_KEY, token); enterApp();
    } catch (e) { els.loginError.textContent = "Could not connect. Check your network or settings."; }
    finally { els.loginBtn.disabled = false; els.loginBtn.textContent = "Enter"; }
  });
  $("logoutBtn").addEventListener("click", () => {
    confirmBox("Sign out this device?", "The passkey will be needed to open the calendar again on this device.", "Sign out", async () => {
      await API.logout(state.token); localStorage.removeItem(TOKEN_KEY); state.token = null; closeModal(); showLogin();
    });
  });
  function handleError(e) {
    if (e && e.invalidSession) { localStorage.removeItem(TOKEN_KEY); state.token = null; closeModal(); showLogin(); return; }
    els.status.textContent = "⚠ Could not reach the shared calendar. Retrying automatically.";
  }

  let refreshTimer = null;
  function enterApp() {
    els.login.classList.add("hidden"); els.app.classList.remove("hidden");
    if (localStorage.getItem("bvc_today_open") === "1") els.todayBox.classList.add("open");
    tickClock(); render(); load();
    clearInterval(refreshTimer);
    refreshTimer = setInterval(() => { if (els.modal.classList.contains("hidden")) load(); }, (CFG.REFRESH_SECONDS || 60) * 1000);
  }

  // ---------- Clock ----------
  let lastDay = ymd(today());
  function tickClock() {
    const n = new Date();
    $("nowDate").textContent = n.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric", year: "numeric" });
    $("nowTime").textContent = n.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
    if (ymd(today()) !== lastDay) { // midnight rollover keeps the TV current
      if (sameDay(state.focus, parse(lastDay))) state.focus = today();
      lastDay = ymd(today()); render(); load();
    }
  }
  setInterval(tickClock, 15000);
  document.addEventListener("visibilitychange", () => { if (!document.hidden && state.token) load(); });

  // ---------- Loading ----------
  function visibleRange() {
    const f = state.focus;
    if (state.view === "month") { const s = mondayOf(new Date(f.getFullYear(), f.getMonth(), 1)); return [s, addDays(s, 41)]; }
    if (state.view === "week") { const s = mondayOf(f); return [s, addDays(s, 6)]; }
    return [f, f];
  }
  async function load() {
    if (!state.token) return;
    const [s, e] = visibleRange(), t = today();
    const from = ymd(s < t ? s : t), to = ymd(e > t ? e : t); // always include today for the summary
    try {
      state.entries = (await API.list(from, to)) || [];
      els.status.textContent = `Updated ${new Date().toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}`;
      render();
    } catch (err) { handleError(err); }
  }

  // ---------- Filtering ----------
  function entriesOn(day) {
    const key = ymd(day);
    return state.entries
      .filter(e => e.start_date <= key && e.end_date >= key)
      .filter(e => state.filter === "all" || e.type === state.filter)
      .sort((a, b) => {
        const ad = isAllDay(a), bd = isAllDay(b);
        if (ad !== bd) return ad ? -1 : 1;
        return (a.start_time || "").localeCompare(b.start_time || "") || a.title.localeCompare(b.title);
      });
  }

  // ---------- Render ----------
  function render() {
    renderToday();
    if (state.view === "month") renderMonth();
    else if (state.view === "week") renderWeek();
    else renderDay();
  }

  function pillHTML(e) {
    const t = e.type === "pto" || isAllDay(e) ? "" : `<span class="t">${esc(timeText(e))}</span>`;
    return `<button class="pill ${e.type}" data-id="${e.id}" title="${esc(displayTitle(e))}">${esc(displayTitle(e))}${t}</button>`;
  }
  function cardHTML(e) {
    const meta = [esc(timeText(e))];
    if (e.start_date !== e.end_date) meta.push(`${fmtShort(parse(e.start_date))} – ${fmtShort(parse(e.end_date))}`);
    if (e.location) meta.push(esc(e.location));
    return `<button class="card ${e.type}" data-id="${e.id}">
      <span class="ctype">${TYPES[e.type].label}</span>
      <span class="ctitle">${esc(displayTitle(e))}</span>
      ${e.type === "contractor" && e.purpose ? `<span class="cmeta">${esc(e.purpose)}</span>` : ""}
      <span class="cmeta">${meta.join(" · ")}</span>
    </button>`;
  }

  function renderMonth() {
    const f = state.focus, month = f.getMonth();
    const first = new Date(f.getFullYear(), month, 1);
    const start = mondayOf(first);
    const last = new Date(f.getFullYear(), month + 1, 0);
    const weeks = Math.ceil((((first.getDay() + 6) % 7) + last.getDate()) / 7);
    els.period.textContent = f.toLocaleDateString(undefined, { month: "long", year: "numeric" });
    const maxPills = weeks > 5 ? 3 : 4;
    let cells = "";
    for (let i = 0; i < weeks * 7; i++) {
      const d = addDays(start, i), list = entriesOn(d);
      const cls = ["cell", d.getMonth() !== month ? "out" : "", sameDay(d, today()) ? "today" : "", i % 7 >= 5 ? "weekend" : ""].join(" ");
      const shown = list.slice(0, maxPills).map(pillHTML).join("");
      const more = list.length > maxPills ? `<button class="more" data-day="${ymd(d)}">+${list.length - maxPills} more</button>` : "";
      cells += `<div class="${cls}">
        <button class="daynum" data-day="${ymd(d)}"><span class="dn">${d.getDate()}</span><span class="wd">${WD_LONG[i % 7]}</span></button>
        <div class="pills">${shown}${more}</div></div>`;
    }
    els.cal.innerHTML = `<div class="dow-row">${WD.map(w => `<div>${w}</div>`).join("")}</div>
      <div class="month-grid" style="grid-template-rows: repeat(${weeks}, 1fr)">${cells}</div>`;
  }

  function renderWeek() {
    const s = mondayOf(state.focus), e = addDays(s, 6);
    els.period.textContent = `${fmtShort(s)} – ${fmtShort(e)}, ${e.getFullYear()}`;
    let cols = "";
    for (let i = 0; i < 7; i++) {
      const d = addDays(s, i), list = entriesOn(d);
      cols += `<div class="wcol ${sameDay(d, today()) ? "today" : ""}">
        <div class="whead" data-day="${ymd(d)}"><div class="wd">${WD_LONG[i]}</div><div class="dn">${d.getDate()}</div></div>
        <div class="wbody">${list.map(cardHTML).join("") || '<div class="empty">—</div>'}</div></div>`;
    }
    els.cal.innerHTML = `<div class="week-grid">${cols}</div>`;
  }

  function renderDay() {
    const d = state.focus, list = entriesOn(d);
    els.period.textContent = d.toLocaleDateString(undefined, { month: "long", day: "numeric", year: "numeric" });
    const allDay = list.filter(isAllDay), timed = list.filter(e => !isAllDay(e));
    els.cal.innerHTML = `<div class="day-wrap">
      <div class="day-head"><span class="big">${d.toLocaleDateString(undefined, { weekday: "long" })}</span>
        ${sameDay(d, today()) ? '<span class="tag">TODAY</span>' : ""}</div>
      <div class="day-section"><h3>ALL DAY</h3><div class="day-cards">${allDay.map(cardHTML).join("") || '<div class="empty">Nothing all-day</div>'}</div></div>
      <div class="day-section"><h3>SCHEDULE</h3><div class="day-cards">${timed.map(cardHTML).join("") || '<div class="empty">No timed activities</div>'}</div></div>
    </div>`;
  }

  function renderToday() {
    const list = entriesOn(today());
    const by = t => list.filter(e => e.type === t);
    els.todayCounts.innerHTML = `
      <span class="c"><span class="dot event"></span>${by("event").length} Events</span>
      <span class="c"><span class="dot contractor"></span>${by("contractor").length} Contractors onsite</span>
      <span class="c"><span class="dot pto"></span>${by("pto").length} PTO / OOO</span>`;
    const col = (t, h) => `<div class="today-col"><h4 style="color:var(--${t})">${h}</h4><ul>${
      by(t).map(e => `<li data-id="${e.id}">${esc(e.title)}${e.type !== "pto" && !isAllDay(e) ? ` <span class="muted">· ${fmtTime(e.start_time)}</span>` : ""}</li>`).join("") || '<li class="none">None</li>'
    }</ul></div>`;
    els.todayBody.innerHTML = col("event", "EVENTS TODAY") + col("contractor", "CONTRACTORS ONSITE") + col("pto", "PTO / OOO TODAY");
  }

  // ---------- Toolbar ----------
  $("viewSeg").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-view]"); if (b) setView(b.dataset.view);
  });
  function setView(v) {
    state.view = v;
    document.querySelectorAll("#viewSeg button").forEach(x => x.classList.toggle("active", x.dataset.view === v));
    render(); load();
  }
  $("filterSeg").addEventListener("click", ev => {
    const b = ev.target.closest("button[data-filter]"); if (!b) return;
    state.filter = b.dataset.filter;
    document.querySelectorAll("#filterSeg button").forEach(x => x.classList.toggle("active", x === b));
    render();
  });
  function shift(dir) {
    const f = state.focus;
    if (state.view === "month") state.focus = new Date(f.getFullYear(), f.getMonth() + dir, 1);
    else state.focus = addDays(f, state.view === "week" ? 7 * dir : dir);
    render(); load();
  }
  $("prevBtn").onclick = () => shift(-1);
  $("nextBtn").onclick = () => shift(1);
  $("todayBtn").onclick = () => { state.focus = today(); render(); load(); };
  $("todayToggle").onclick = () => {
    els.todayBox.classList.toggle("open");
    localStorage.setItem("bvc_today_open", els.todayBox.classList.contains("open") ? "1" : "0");
  };
  $("addBtn").onclick = () => openTypeChooser();

  // Calendar clicks
  document.addEventListener("click", ev => {
    const item = ev.target.closest("[data-id]");
    if (item && !els.modal.contains(item)) { const e = state.entries.find(x => String(x.id) === item.dataset.id); if (e) openDetails(e); return; }
    const day = ev.target.closest("[data-day]");
    if (day && els.cal.contains(day)) { state.focus = parse(day.dataset.day); setView("day"); }
  });

  // ---------- Modal ----------
  function openModal(html) { els.modalCard.innerHTML = html; els.modal.classList.remove("hidden"); }
  function closeModal() { els.modal.classList.add("hidden"); els.modalCard.innerHTML = ""; }
  els.modal.addEventListener("click", ev => { if (ev.target === els.modal) closeModal(); });
  document.addEventListener("keydown", ev => { if (ev.key === "Escape") closeModal(); });

  function openTypeChooser() {
    openModal(`<h2>What would you like to add?</h2>
      <div class="choice-grid">
        ${Object.entries(TYPES).map(([k, t]) => `<button class="choice ${k}" data-type="${k}"><span class="dot ${k}"></span>${t.add}</button>`).join("")}
      </div>
      <div class="actions"><button class="btn btn-light" data-close>Cancel</button></div>`);
    els.modalCard.querySelectorAll("[data-type]").forEach(b => (b.onclick = () => openForm({ type: b.dataset.type })));
    els.modalCard.querySelector("[data-close]").onclick = closeModal;
  }

  function openForm(entry) {
    const isNew = !entry.id, t = entry.type;
    const base = state.view === "month" && state.focus.getMonth() === today().getMonth() ? today() : state.focus;
    const e = Object.assign({ start_date: ymd(base), end_date: ymd(base), all_day: t === "pto" }, entry);
    const v = k => esc(e[k] ?? "");
    const time = k => esc((e[k] || "").slice(0, 5));

    const titleField = {
      event: `<label class="full">Event title *<input name="title" required value="${v("title")}" placeholder="e.g. Pilot Plant Demo"></label>`,
      contractor: `<label class="full">Contractor / vendor / company *<input name="title" required value="${v("title")}" placeholder="e.g. ABC Electric"></label>
                   <label class="full">Purpose of visit / work<input name="purpose" value="${v("purpose")}" placeholder="e.g. Panel upgrade"></label>`,
      pto: `<label class="full">Person / name *<input name="title" required value="${v("title")}" placeholder="e.g. Dina"></label>`
    }[t];
    const dates = `<label>Start date *<input type="date" name="start_date" required value="${v("start_date")}"></label>
      <label>End date<input type="date" name="end_date" value="${v("end_date")}"><span class="hint">Same as start for a single day</span></label>`;
    const allDay = `<label class="check full"><input type="checkbox" name="all_day" ${e.all_day ? "checked" : ""}> All day</label>`;
    const times = `<label class="tf">Start time<input type="time" name="start_time" value="${time("start_time")}"></label>
      <label class="tf">End time<input type="time" name="end_time" value="${time("end_time")}"></label>`;
    const extra = t === "pto" ? "" : `
      <label class="full">${t === "event" ? "Location" : "Location / area"}<input name="location" value="${v("location")}"></label>
      <label class="full">${t === "event" ? "Host / owner" : "Nestlé host / contact"}<input name="host" value="${v("host")}"></label>
      <label class="full">Short notes<textarea name="notes" maxlength="500">${v("notes")}</textarea></label>`;

    openModal(`<span class="type-badge ${t}"><span class="dot ${t}"></span>${TYPES[t].label}</span>
      <h2>${isNew ? TYPES[t].add : "Edit " + TYPES[t].label.toLowerCase()}</h2>
      <form class="form" id="entryForm">${titleField}${dates}${allDay}${times}${extra}
        <div class="error full" id="formError"></div>
        <div class="actions full">
          ${isNew ? '<button type="button" class="btn btn-light left" data-back>‹ Back</button>' : ""}
          <button type="button" class="btn btn-light" data-close>Cancel</button>
          <button type="submit" class="btn btn-primary">${isNew ? "Save" : "Save changes"}</button>
        </div></form>`);

    const form = $("entryForm"), f = form.elements;
    const toggleTimes = () => form.querySelectorAll(".tf").forEach(x => x.classList.toggle("hidden", f.all_day.checked));
    f.all_day.onchange = toggleTimes; toggleTimes();
    f.start_date.addEventListener("change", () => { if (!f.end_date.value || f.end_date.value < f.start_date.value) f.end_date.value = f.start_date.value; });
    form.querySelector("[data-close]").onclick = closeModal;
    const back = form.querySelector("[data-back]"); if (back) back.onclick = openTypeChooser;
    setTimeout(() => f.title.focus(), 50);

    form.onsubmit = async ev => {
      ev.preventDefault();
      const err = $("formError"); err.textContent = "";
      const val = n => (f[n] ? f[n].value : "");
      const out = {
        id: e.id || "", type: t, title: val("title").trim(), purpose: val("purpose"),
        start_date: val("start_date"), end_date: val("end_date") || val("start_date"),
        all_day: f.all_day.checked,
        start_time: f.all_day.checked ? "" : val("start_time"),
        end_time: f.all_day.checked ? "" : val("end_time"),
        location: val("location"), host: val("host"), notes: val("notes")
      };
      if (!out.title) return (err.textContent = "Please enter a name/title.");
      if (out.end_date < out.start_date) return (err.textContent = "End date can't be before the start date.");
      if (!out.all_day && t !== "pto" && !out.start_time) return (err.textContent = "Add a start time or select All day.");
      if (out.start_time && out.end_time && out.end_time <= out.start_time) return (err.textContent = "End time must be after start time.");
      if (t === "pto" && !out.start_time) out.all_day = true;
      const btn = form.querySelector("[type=submit]"); btn.disabled = true; btn.textContent = "Saving…";
      try {
        const saved = await API.save(out);
        closeModal();
        if (saved && saved.start_date && state.view !== "month") state.focus = parse(saved.start_date);
        await load();
      } catch (x) { handleError(x); err.textContent = "Could not save. Please try again."; btn.disabled = false; btn.textContent = "Save"; }
    };
  }

  function openDetails(e) {
    const rows = [];
    const add = (k, val) => { if (val) rows.push(`<dt>${k}</dt><dd>${esc(val)}</dd>`); };
    if (e.type === "contractor") { add("Company", e.title); add("Purpose", e.purpose); }
    else if (e.type === "pto") add("Person", e.title);
    else add("Event", e.title);
    add(e.start_date === e.end_date ? "Date" : "Dates", dateRangeText(e));
    add("Time", timeText(e));
    if (e.type !== "pto") {
      add("Location", e.location);
      add(e.type === "event" ? "Host / owner" : "Nestlé host", e.host);
      add("Notes", e.notes);
    }
    openModal(`<span class="type-badge ${e.type}"><span class="dot ${e.type}"></span>${TYPES[e.type].label}</span>
      <h2>${esc(displayTitle(e))}</h2>
      <dl class="detail-list">${rows.join("")}</dl>
      <div class="actions">
        <button class="btn btn-danger left" data-del>Delete</button>
        <button class="btn btn-light" data-close>Close</button>
        <button class="btn btn-primary" data-edit>Edit</button>
      </div>`);
    els.modalCard.querySelector("[data-close]").onclick = closeModal;
    els.modalCard.querySelector("[data-edit]").onclick = () => openForm(e);
    els.modalCard.querySelector("[data-del]").onclick = () =>
      confirmBox("Delete this activity?", `"${displayTitle(e)}" will be removed for everyone.`, "Delete", async () => {
        try { await API.remove(e.id); closeModal(); await load(); } catch (x) { handleError(x); }
      }, () => openDetails(e));
  }

  function confirmBox(title, msg, okText, onOk, onCancel) {
    openModal(`<h2>${esc(title)}</h2><p>${esc(msg)}</p>
      <div class="actions"><button class="btn btn-light" data-no>Cancel</button><button class="btn btn-danger" data-yes>${esc(okText)}</button></div>`);
    els.modalCard.querySelector("[data-no]").onclick = () => (onCancel ? onCancel() : closeModal());
    els.modalCard.querySelector("[data-yes]").onclick = async ev => { ev.target.disabled = true; await onOk(); };
  }

  boot();
})();
