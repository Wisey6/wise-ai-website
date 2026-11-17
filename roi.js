/* ===========================================================================
   Wise AI: missed enquiry calculator
   - Everything is worked out in the browser. Nothing is sent anywhere unless
     the visitor uses "Send me these numbers", which POSTs to `lead-intake`
     with a readable summary of their inputs and results.
   - The maths (a month = 52/12 weeks):
       missed / month   = enquiries per week × missed share × 52/12
       jobs lost / month = missed / month × close rate
       revenue / month   = jobs lost / month × average job value   (× 12 for a year)
       admin / month     = admin hours per week × hourly cost × 52/12
       fixing half       = (revenue / month + admin / month) ÷ 2   (× 12 for a year)
   =========================================================================== */

const LEAD_INTAKE_URL =
  "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/lead-intake";
const SOURCE = "wise-ai.au/roi";

(function () {
  "use strict";

  const WEEKS_PER_MONTH = 52 / 12;
  const $ = (id) => document.getElementById(id);

  /* Example starting figures. They are placeholders to edit, not claims. */
  const INPUTS = [
    { id: "enq", label: "Enquiries per week", hint: "Calls, texts, emails and web forms, all together.",
      value: 15, min: 0, max: 200, step: 1, sliderMax: 100, suffix: "" },
    { id: "miss", label: "Share missed or answered late", hint: "Not picked up, replied to the next day, or never followed up.",
      value: 20, min: 0, max: 100, step: 1, sliderMax: 100, suffix: "%" },
    { id: "job", label: "Average job value", hint: "What a typical job or sale is worth to you.",
      value: 600, min: 0, max: 1000000, step: 50, sliderMax: 10000, prefix: "$" },
    { id: "close", label: "Close rate", hint: "Out of 10 enquiries you answer properly, how many become work.",
      value: 30, min: 0, max: 100, step: 1, sliderMax: 100, suffix: "%" },
    { id: "hrs", label: "Admin hours per week", hint: "Re-typing, chasing, replying to the same questions. Whole team.",
      value: 6, min: 0, max: 168, step: 1, sliderMax: 60, suffix: "hrs" },
    { id: "rate", label: "Hourly cost of that time", hint: "A wage plus on-costs, or what an hour of yours is worth.",
      value: 45, min: 0, max: 2000, step: 5, sliderMax: 200, prefix: "$" }
  ];

  const state = {};

  /* ---------- formatting ---------- */
  const money = (n) => "$" + Math.round(n).toLocaleString("en-AU");
  const num = (n, dp) => {
    const f = Math.pow(10, dp);
    return (Math.round(n * f) / f).toLocaleString("en-AU", { maximumFractionDigits: dp });
  };
  const plain = (n) => n.toLocaleString("en-AU", { maximumFractionDigits: 2 });

  /* ---------- build the inputs ---------- */
  const host = $("inputs");
  INPUTS.forEach((d) => {
    state[d.id] = d.value;
    const row = document.createElement("div");
    row.className = "crow";
    row.innerHTML =
      `<div class="ctop">` +
        `<label for="n-${d.id}" id="l-${d.id}">${d.label}</label>` +
        `<div class="numbox">${d.prefix ? `<span aria-hidden="true">${d.prefix}</span>` : ""}` +
          `<input id="n-${d.id}" type="number" inputmode="decimal" min="${d.min}" max="${d.max}" step="any" value="${d.value}" aria-describedby="h-${d.id}">` +
          `${d.suffix ? `<span aria-hidden="true">${d.suffix}</span>` : ""}</div>` +
      `</div>` +
      `<input type="range" id="s-${d.id}" min="${d.min}" max="${d.sliderMax}" step="${d.step}" value="${Math.min(d.value, d.sliderMax)}" aria-labelledby="l-${d.id}" aria-describedby="h-${d.id}">` +
      `<p class="hint" id="h-${d.id}">${d.hint}</p>`;
    host.appendChild(row);

    const box = row.querySelector(`#n-${d.id}`);
    const slider = row.querySelector(`#s-${d.id}`);
    paintSlider(slider);

    slider.addEventListener("input", () => {
      state[d.id] = Number(slider.value);
      box.value = slider.value;
      paintSlider(slider);
      update();
    });
    box.addEventListener("input", () => {
      const v = parseFloat(box.value);
      state[d.id] = isFinite(v) ? Math.min(Math.max(v, d.min), d.max) : 0;
      slider.value = Math.min(state[d.id], d.sliderMax);
      paintSlider(slider);
      update();
    });
    box.addEventListener("blur", () => {
      // Tidy the box to the value actually used (clamped, never blank).
      box.value = state[d.id];
    });
  });

  function paintSlider(s) {
    const p = ((Number(s.value) - Number(s.min)) / (Number(s.max) - Number(s.min))) * 100;
    s.style.setProperty("--p", (isFinite(p) ? p : 0) + "%");
  }

  /* ---------- the maths ---------- */
  function compute(s) {
    const missedPerMonth = s.enq * (s.miss / 100) * WEEKS_PER_MONTH;
    const jobsLost = missedPerMonth * (s.close / 100);
    const revMonth = jobsLost * s.job;
    const adminMonth = s.hrs * s.rate * WEEKS_PER_MONTH;
    const halfMonth = (revMonth + adminMonth) / 2;
    return {
      missedPerMonth, jobsLost, revMonth, revYear: revMonth * 12,
      adminMonth, halfMonth, halfYear: halfMonth * 12
    };
  }
  window.WiseROI = { compute: compute, state: state }; // exposed for checking the maths

  /* ---------- render ---------- */
  let liveTimer = null;
  function update() {
    const s = state, r = compute(s);
    $("rRevMonth").textContent = money(r.revMonth);
    $("rRevYear").textContent = money(r.revYear);
    $("rJobs").textContent = num(r.jobsLost, 1);
    $("rAdmin").textContent = money(r.adminMonth);
    $("rHalfMonth").textContent = money(r.halfMonth) + " a month";
    $("rHalfYear").textContent = money(r.halfYear);
    $("peekVal").textContent = money(r.revMonth);

    const lines = [
      ["Missed or late enquiries a month", `${plain(s.enq)} a week × ${plain(s.miss)}% × 52 ÷ 12`, num(r.missedPerMonth, 1)],
      ["Jobs lost a month", `${num(r.missedPerMonth, 1)} × ${plain(s.close)}% close rate`, num(r.jobsLost, 1)],
      ["Left on the table a month", `${num(r.jobsLost, 1)} jobs × ${money(s.job)}`, money(r.revMonth)],
      ["Left on the table a year", `${money(r.revMonth)} × 12`, money(r.revYear)],
      ["Admin cost a month", `${plain(s.hrs)} hrs × ${money(s.rate)} × 52 ÷ 12`, money(r.adminMonth)],
      ["Fixing half, a month", `(${money(r.revMonth)} + ${money(r.adminMonth)}) ÷ 2`, money(r.halfMonth)],
      ["Fixing half, a year", `${money(r.halfMonth)} × 12`, money(r.halfYear)]
    ];
    $("working").innerHTML = lines.map(([k, eq, v]) =>
      `<li><span>${k} <span class="eq">= ${eq}</span></span><b>${v}</b></li>`).join("");

    clearTimeout(liveTimer);
    liveTimer = setTimeout(() => {
      $("live").textContent =
        `About ${money(r.revMonth)} a month left on the table, ${money(r.adminMonth)} a month on admin. Fixing half would be worth about ${money(r.halfMonth)} a month.`;
    }, 700);
  }
  update();

  /* On phones the results sit below the inputs, so a small bar keeps the
     headline figure in view while the inputs are on screen. */
  if ("IntersectionObserver" in window) {
    const peek = $("peek");
    let inputsOn = false, resultsOn = false;
    const sync = () => peek.classList.toggle("on", inputsOn && !resultsOn);
    new IntersectionObserver((es) => { es.forEach((e) => { inputsOn = e.isIntersecting; }); sync(); })
      .observe($("inputs"));
    new IntersectionObserver((es) => { es.forEach((e) => { resultsOn = e.isIntersecting; }); sync(); }, { threshold: 0.35 })
      .observe($("results"));
  }

  function summary() {
    const s = state, r = compute(s);
    return `Missed enquiry calculator. Their numbers: ${plain(s.enq)} enquiries a week, ${plain(s.miss)}% missed or late, ` +
      `${money(s.job)} average job, ${plain(s.close)}% close rate, ${plain(s.hrs)} admin hrs a week at ${money(s.rate)}/hr. ` +
      `Result: ${num(r.jobsLost, 1)} jobs lost a month, ${money(r.revMonth)} a month (${money(r.revYear)} a year) left on the table, ` +
      `${money(r.adminMonth)} a month admin cost, fixing half worth about ${money(r.halfMonth)} a month (${money(r.halfYear)} a year).`;
  }

  /* ---------- "Send me these numbers" ---------- */
  function normalisePhone(raw) {
    if (!raw) return null;
    let p = String(raw).replace(/[\s\-().]/g, "");
    if (/^\+6104\d{8}$/.test(p)) p = "+61" + p.slice(4);
    else if (/^04\d{8}$/.test(p)) p = "+61" + p.slice(1);
    else if (/^614\d{8}$/.test(p)) p = "+" + p;
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  const form = $("sendForm"), err = $("sendErr"), btn = $("sendBtn");
  const val = (id) => ($(id).value || "").trim();
  const ids = ["sName", "sEmail", "sPhone"];

  function invalid(list) {
    ids.forEach((id) => $(id).removeAttribute("aria-invalid"));
    list.forEach((id) => $(id).setAttribute("aria-invalid", "true"));
    if (list[0]) $(list[0]).focus();
  }

  function validate() {
    const name = val("sName"), email = val("sEmail"), phone = val("sPhone");
    if (!name) { invalid(["sName"]); return "I just need your name."; }
    if (!email && !phone) { invalid(["sEmail", "sPhone"]); return "Add an email or a mobile so I can send them to you."; }
    if (email && !EMAIL_RE.test(email)) { invalid(["sEmail"]); return "That email doesn't look right, mind checking it?"; }
    if (phone && !normalisePhone(phone) && !email) { invalid(["sPhone"]); return "I can't read that number. Use a mobile like 0400 000 000, or add an email instead."; }
    invalid([]);
    return "";
  }

  function mailtoHref() {
    const body = ["Hi Tyler,", "", "Here are my numbers from the calculator:", "", summary(), "",
      "Name: " + (val("sName") || "-"), "Email: " + (val("sEmail") || "-"), "Mobile: " + (val("sPhone") || "-")].join("\n");
    return "mailto:tyler@wise-ai.au?subject=" + encodeURIComponent("My missed enquiry numbers") + "&body=" + encodeURIComponent(body);
  }

  function show(which) {
    const ok = which === "ok";
    if (ok) {
      const first = val("sName").split(/\s+/)[0];
      $("doneTitle").textContent = first ? `Thanks, ${first}. I've got your numbers.` : "Thanks. I've got your numbers.";
      form.hidden = true;
    } else {
      $("failMail").setAttribute("href", mailtoHref());
    }
    $("doneFail").hidden = ok;
    $("doneOk").hidden = !ok;
    const el = ok ? $("doneOk") : $("doneFail");
    el.focus({ preventScroll: true });
    el.scrollIntoView({ behavior: "smooth", block: "center" });
  }

  async function send(payload) {
    const ctrl = "AbortController" in window ? new AbortController() : null;
    const timer = ctrl ? setTimeout(() => ctrl.abort(), 15000) : null;
    try {
      const res = await fetch(LEAD_INTAKE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: ctrl ? ctrl.signal : undefined
      });
      let data = null;
      try { data = await res.json(); } catch (e) { /* non-JSON body */ }
      return res.ok && (!data || data.ok !== false);
    } catch (e) {
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    err.textContent = "";
    $("doneFail").hidden = true;
    const problem = validate();
    if (problem) { err.textContent = problem; return; }
    if (val("website")) { show("ok"); return; } // honeypot: people never fill it

    const rawPhone = val("sPhone");
    const payload = {
      name: val("sName"),
      email: val("sEmail") || null,
      phone: normalisePhone(rawPhone),
      business: null,
      source: SOURCE,
      summary: summary() + (rawPhone && !normalisePhone(rawPhone) ? " Phone as typed: " + rawPhone + "." : ""),
      website: ""
    };
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sending...";
    const ok = await send(payload);
    btn.disabled = false;
    btn.textContent = label;
    show(ok ? "ok" : "fail");
  });

  $("retryBtn").addEventListener("click", () => {
    $("doneFail").hidden = true;
    form.requestSubmit ? form.requestSubmit() : btn.click();
  });
  ids.forEach((id) => $(id).addEventListener("input", () => $(id).removeAttribute("aria-invalid")));
})();
