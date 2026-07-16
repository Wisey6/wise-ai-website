/* ===========================================================================
   Wise AI: 2-minute AI audit
   - One question at a time, with a progress bar.
   - On submit: computes a tailored recommendation, then POSTs the lead to the
     Supabase `submit-lead` edge function, which (1) stores it in the
     `website_leads` table and (2) emails Tyler. Result shows instantly; the
     network call runs in the background with a mailto fallback.
   =========================================================================== */

const LEAD_ENDPOINT =
  "https://uyopyiucnklwrddxpgzq.supabase.co/functions/v1/submit-lead";

/* ---------- Questions (sharp, consultative, mapped to the service wedges) --- */
const QUESTIONS = [
  {
    id: "trade", q: "What kind of business do you run?",
    help: "So I can talk in your language, not jargon.",
    opts: [
      { t: "On the tools — trades & construction", v: "trades" },
      { t: "Health, beauty & wellness", v: "wellness" },
      { t: "Hospitality, food & events", v: "hospitality" },
      { t: "Retail or online store", v: "retail" },
      { t: "Professional & other services", v: "services" }
    ]
  },
  {
    id: "size", q: "How big is the team?",
    help: "Including you.",
    opts: [
      { t: "Just me — sole trader", v: "solo" },
      { t: "2–10 people", v: "small" },
      { t: "11–25 people", v: "mid" },
      { t: "26+ people", v: "large" }
    ]
  },
  {
    id: "pain", multi: true, q: "Where does the week actually go?",
    help: "Pick the ones that bite. Choose all that apply.",
    opts: [
      { t: "Booking, scheduling & the no-show chase", v: "booking" },
      { t: "Chasing leads & quotes that go cold", v: "leads" },
      { t: "Invoicing & getting paid on time", v: "invoicing" },
      { t: "Data entry, banking & reconciliation", v: "admin" },
      { t: "Answering the same questions over and over", v: "enquiries" }
    ]
  },
  {
    id: "leads", q: "A new enquiry lands at 7pm. What happens?",
    help: "Be honest — this is where money leaks.",
    opts: [
      { t: "They get an instant reply, any hour", v: "auto" },
      { t: "We answer when we get to it — could be tomorrow", v: "manual" },
      { t: "Honestly, some slip through the cracks", v: "leak" }
    ]
  },
  {
    id: "hours", q: "How many hours a week vanish into repetitive admin?",
    help: "Across the whole team, roughly.",
    opts: [
      { t: "Under 5", v: "low" },
      { t: "5–15", v: "med" },
      { t: "15+ — it's a real drain", v: "high" },
      { t: "No idea, but too many", v: "unknown" }
    ]
  },
  {
    id: "tools", q: "How are you handling all this today?",
    help: "The current setup, warts and all.",
    opts: [
      { t: "Manually — spreadsheets, notebooks, memory", v: "manual" },
      { t: "A patchwork of apps that don't talk to each other", v: "patchwork" },
      { t: "Pretty automated already", v: "auto" }
    ]
  },
  {
    id: "urgency", q: "How soon do you want this sorted?",
    help: "No wrong answer — it just tells me where to start.",
    opts: [
      { t: "Yesterday — it's holding us back", v: "now" },
      { t: "Next month or two", v: "soon" },
      { t: "Just exploring for now", v: "explore" }
    ]
  }
];

/* ---------- Solution library, keyed by the main pain ---------- */
const SOLUTIONS = {
  booking: {
    title: "Booking & no-show automation",
    desc: "An automated booking flow that fills your diary, confirms and reminds customers, and chases the ones who go quiet — so the back-and-forth stops eating your day and empty slots stop costing you.",
    bullets: ["Online booking that syncs straight to your calendar", "Automatic confirmations, reminders & reschedules", "No-show follow-ups that recover the revenue", "Live in ~2 weeks, on your own accounts"]
  },
  leads: {
    title: "Lead-to-quote automation",
    desc: "Every enquiry gets an instant response, gets logged, and gets followed up on a schedule — so the leads you're quietly losing turn into booked, quoted work instead.",
    bullets: ["Instant reply to every new enquiry, any hour", "Nothing slips: every lead tracked to an outcome", "Automated follow-up until they book or decline", "Turn website visitors into quotes on autopilot"]
  },
  invoicing: {
    title: "Invoicing & payment-link automation",
    desc: "Invoices go out the moment a job's done, payment links do the collecting, and reminders chase what's overdue — so you get paid faster without lifting a finger.",
    bullets: ["Invoices raised & sent automatically", "One-tap payment links for customers", "Polite, automatic reminders on overdue accounts", "Fewer late payments, less chasing"]
  },
  admin: {
    title: "Admin & reconciliation automation",
    desc: "The data entry, the banking, the reconciliation — the invisible work that eats hours, handed to a system that just does it, accurately, in the background.",
    bullets: ["Data entry & record-keeping automated", "Bank & transaction reconciliation handled", "Fewer errors, no more end-of-week catch-up", "Your team back on the work that actually pays"]
  },
  enquiries: {
    title: "Customer enquiry automation",
    desc: "The same questions, answered instantly and consistently, day or night — so your team stops repeating themselves and customers get a faster response.",
    bullets: ["Instant answers to your most common questions", "Consistent, on-brand responses 24/7", "Only the real conversations reach a human", "Faster replies without adding headcount"]
  }
};

/* =========================================================================
   Step engine — one screen at a time
   ========================================================================= */
const answers = {};
const contact = {};
const STEPS = QUESTIONS.map(q => ({ kind: "q", q })).concat([{ kind: "contact" }]);
let step = 0;
let advancing = false;

const stage = document.getElementById("stage");
const bar = document.getElementById("progressBar");
const stepCount = document.getElementById("stepCount");
const backBtn = document.getElementById("backBtn");
const nextBtn = document.getElementById("nextBtn");
const err = document.getElementById("err");

function setProgress() {
  // fill reflects how many steps are behind you
  const pct = Math.round((step / STEPS.length) * 100);
  bar.style.width = pct + "%";
  if (STEPS[step].kind === "contact") {
    stepCount.textContent = "Last step — where do I send it?";
  } else {
    stepCount.textContent = `Question ${step + 1} of ${QUESTIONS.length}`;
  }
}

function render() {
  err.textContent = "";
  advancing = false;
  const s = STEPS[step];
  backBtn.hidden = step === 0;
  setProgress();

  const card = document.createElement("div");
  card.className = "qcard";

  if (s.kind === "q") {
    const question = s.q;
    const chosen = answers[question.id];
    const hint = question.multi ? `<span class="qhint">select all that apply</span>` : "";
    card.innerHTML =
      `<div class="q">${question.q}${hint}</div>` +
      (question.help ? `<div class="qsub">${question.help}</div>` : "");

    const opts = document.createElement("div");
    opts.className = "opts";
    question.opts.forEach(o => {
      const b = document.createElement("button");
      b.type = "button";
      b.className = "opt" + (question.multi ? " multi" : "");
      const on = question.multi
        ? Array.isArray(chosen) && chosen.indexOf(o.v) >= 0
        : chosen === o.v;
      if (on) b.classList.add("sel");
      b.innerHTML = `<span class="dot"></span><span>${o.t}</span>`;
      b.addEventListener("click", () => onPick(question, o, b, opts));
      opts.appendChild(b);
    });
    card.appendChild(opts);

    // single-select auto-advances; multi needs the Continue button
    nextBtn.hidden = !question.multi;
    nextBtn.textContent = "Continue";
  } else {
    // contact step
    nextBtn.hidden = false;
    nextBtn.textContent = "Sounds good";
    card.innerHTML = `
      <div class="q">Where should I send your result?</div>
      <div class="qsub">Instant on-screen — plus I'll follow up personally, no pressure.</div>
      <div class="row2">
        <div class="field">
          <label for="name">Your name</label>
          <input id="name" type="text" placeholder="Jane Smith" autocomplete="name" value="${contact.name || ""}">
        </div>
        <div class="field">
          <label for="business">Business name</label>
          <input id="business" type="text" placeholder="Smith &amp; Co" autocomplete="organization" value="${contact.business || ""}">
        </div>
      </div>
      <div class="row2">
        <div class="field">
          <label for="email">Email</label>
          <input id="email" type="email" placeholder="jane@business.com" autocomplete="email" inputmode="email" value="${contact.email || ""}">
        </div>
        <div class="field">
          <label for="phone">Contact number</label>
          <input id="phone" type="tel" placeholder="0400 000 000" autocomplete="tel" inputmode="tel" value="${contact.phone || ""}">
        </div>
      </div>`;
  }

  stage.replaceChildren(card);
  requestAnimationFrame(() => card.classList.add("in"));
}

function onPick(question, o, btn, opts) {
  if (question.multi) {
    const arr = answers[question.id] || (answers[question.id] = []);
    const i = arr.indexOf(o.v);
    if (i >= 0) { arr.splice(i, 1); btn.classList.remove("sel"); }
    else { arr.push(o.v); btn.classList.add("sel"); }
    return;
  }
  // single-select: highlight then auto-advance
  answers[question.id] = o.v;
  opts.querySelectorAll(".opt").forEach(el => el.classList.remove("sel"));
  btn.classList.add("sel");
  if (advancing) return;
  advancing = true;
  setTimeout(next, 260);
}

function saveContact() {
  ["name", "business", "email", "phone"].forEach(id => {
    const el = document.getElementById(id);
    if (el) contact[id] = el.value.trim();
  });
}

function next() {
  const s = STEPS[step];
  if (s.kind === "q") {
    const a = answers[s.q.id];
    const answered = s.q.multi ? (Array.isArray(a) && a.length > 0) : !!a;
    if (!answered) { err.textContent = "Pick an option to keep going."; return; }
    step++;
    render();
    scrollTop();
    return;
  }
  // contact step -> validate and finish
  saveContact();
  if (!contact.name || !contact.email || !contact.phone) {
    err.textContent = "I just need your name, email and a contact number."; return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(contact.email)) {
    err.textContent = "That email doesn't look right — mind checking it?"; return;
  }
  finish();
}

function back() {
  if (STEPS[step].kind === "contact") saveContact();
  if (step > 0) { step--; render(); scrollTop(); }
}

function scrollTop() {
  document.querySelector(".glass").scrollIntoView({ behavior: "smooth", block: "start" });
}

nextBtn.addEventListener("click", next);
backBtn.addEventListener("click", back);
document.addEventListener("keydown", e => {
  if (e.key === "Enter" && !document.getElementById("result").classList.contains("show")) {
    if (!nextBtn.hidden) next();
  }
});

/* ---------- Fit + recommendation logic ---------- */
function computeFit() {
  let s = 0;
  if (answers.hours === "high") s += 3;
  else if (answers.hours === "med" || answers.hours === "unknown") s += 2;
  else if (answers.hours === "low") s += 1;
  if (answers.tools === "manual" || answers.tools === "patchwork") s += 2;
  if (answers.leads === "leak") s += 2;
  else if (answers.leads === "manual") s += 1;
  if (answers.urgency === "now") s += 2;
  else if (answers.urgency === "soon") s += 1;
  const pains = Array.isArray(answers.pain) ? answers.pain.length : 0;
  if (pains >= 3) s += 2; else if (pains === 2) s += 1;
  return s;
}

function pickSolutions() {
  let keys = Array.isArray(answers.pain) ? answers.pain.slice() : (answers.pain ? [answers.pain] : []);
  if (keys.length === 0) {
    if (answers.leads === "leak" || answers.leads === "manual") keys.push("leads");
    else keys.push("admin");
  }
  const seen = {};
  const sols = keys.filter(k => SOLUTIONS[k] && !seen[k] && (seen[k] = 1));
  return (sols.length ? sols : ["admin"]);
}

/* ---------- Finish: render result + fire lead to backend ---------- */
function finish() {
  const score = computeFit();
  const solKeys = pickSolutions();
  const sols = solKeys.map(k => SOLUTIONS[k]);
  const first = contact.name.split(" ")[0];

  const badge = document.getElementById("verdictBadge");
  const vTitle = document.getElementById("verdictTitle");
  const vText = document.getElementById("verdictText");
  let band;

  if (answers.tools === "auto" && score <= 3) {
    band = "Worth a chat";
    vTitle.textContent = `You're already ahead, ${first}.`;
    vText.textContent = "You've automated a fair bit, so the wins here are sharper and more specific. A quick look would tell us whether there's a worthwhile layer left to squeeze, or if you're already set.";
  } else if (score >= 6) {
    band = "Strong fit";
    vTitle.textContent = `There's real time to reclaim, ${first}.`;
    vText.textContent = "Based on your answers, repetitive work is quietly costing you hours and money every week. This is exactly the kind of business I build for — and there's a clear place to start.";
  } else {
    band = "Good fit";
    vTitle.textContent = `Yes, there's something here for you, ${first}.`;
    vText.textContent = "You've got repetitive work worth removing. It may not be drowning you yet, but there's a straightforward first win that pays for itself.";
  }
  badge.textContent = band;

  const wrap = document.getElementById("recoWrap");
  wrap.innerHTML = "";
  sols.forEach((sol, i) => {
    const c = document.createElement("div");
    c.className = "reco";
    c.style.marginTop = i === 0 ? "8px" : "14px";
    const lis = sol.bullets.map(b => `<li><svg viewBox="0 0 24 24"><path d="M5 12.5l4 4 10-11"/></svg><span>${b}</span></li>`).join("");
    const label = i === 0 ? "Where I&rsquo;d start" : "Also worth automating";
    c.innerHTML = `<div class="rl">${label}</div><div class="rt">${sol.title}</div><div class="rd">${sol.desc}</div><ul>${lis}</ul>`;
    wrap.appendChild(c);
  });

  // mailto fallback (also nice for the prospect to have a thread)
  const subject = encodeURIComponent(`AI audit — ${contact.business || contact.name}: ${sols[0].title}`);
  const bodyLines = [
    `Name: ${contact.name}`,
    `Business: ${contact.business || "-"}`,
    `Email: ${contact.email}`,
    `Phone: ${contact.phone}`,
    ``,
    `Recommended starting points: ${sols.map(s => s.title).join(", ")}`,
    ``,
    `I'd like a no-pressure walkthrough.`
  ];
  document.getElementById("bookBtn").setAttribute(
    "href",
    `mailto:tyler@wiseai.website?subject=${subject}&body=${encodeURIComponent(bodyLines.join("\n"))}`
  );

  // build the payload for Supabase + email
  const payload = {
    name: contact.name,
    business: contact.business || null,
    email: contact.email,
    phone: contact.phone,
    fit_band: band,
    fit_score: score,
    top_solution: sols[0].title,
    recommendations: sols.map(s => s.title),
    answers: readableAnswers(),
    source: "wiseai.website/quiz",
    user_agent: navigator.userAgent,
    referrer: document.referrer || null
  };

  // show result immediately, submit in the background
  bar.style.width = "100%";
  document.getElementById("app").style.display = "none";
  const result = document.getElementById("result");
  result.classList.add("show");
  result.scrollIntoView({ behavior: "smooth", block: "start" });

  submitLead(payload);
}

function readableAnswers() {
  const out = {};
  QUESTIONS.forEach(q => {
    const a = answers[q.id];
    out[q.q] = q.multi
      ? (a || []).map(v => (q.opts.find(o => o.v === v) || {}).t).filter(Boolean)
      : ((q.opts.find(o => o.v === a) || {}).t || null);
  });
  return out;
}

function submitLead(payload) {
  try {
    fetch(LEAD_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      keepalive: true
    }).catch(() => {});
  } catch (e) { /* result already shown; mailto is the fallback */ }
}

/* ---------- Start over ---------- */
document.getElementById("againBtn").addEventListener("click", () => {
  Object.keys(answers).forEach(k => delete answers[k]);
  Object.keys(contact).forEach(k => delete contact[k]);
  step = 0;
  document.getElementById("result").classList.remove("show");
  document.getElementById("app").style.display = "block";
  render();
  scrollTop();
});

/* ---------- Kick off ---------- */
render();
