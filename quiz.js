/* ===========================================================================
   Wise AI: 2-minute audit
   NOTE: lead delivery is currently a mailto placeholder. Once the email route
   is chosen (Resend serverless fn, recommended, or Formspree), replace the
   submit handler's mailto with a POST that (1) emails the lead to
   tyler@wiseai.website and (2) auto-replies "thanks, we'll be in touch" to
   the prospect.
   =========================================================================== */

/* ---------- Questions (mapped to the Wise AI service wedges) ---------- */
const QUESTIONS = [
  {
    id:"size", q:"How big is your business?",
    opts:[
      {t:"Just me, sole trader", v:"solo"},
      {t:"2–10 people", v:"small"},
      {t:"11–25 people", v:"mid"},
      {t:"26–45 people", v:"large"},
      {t:"More than 45", v:"xl"}
    ]
  },
  {
    id:"pain", multi:true, q:"Where does most of your team's time disappear?",
    opts:[
      {t:"Booking & scheduling: the back-and-forth, the diary", v:"booking"},
      {t:"Chasing leads & quotes that go cold", v:"leads"},
      {t:"Invoicing & getting paid on time", v:"invoicing"},
      {t:"Data entry, banking & reconciliation", v:"admin"},
      {t:"Answering the same customer questions", v:"enquiries"}
    ]
  },
  {
    id:"bookings", q:"Do customers book appointments or time with you?",
    opts:[
      {t:"Yes, and no-shows / the chase cost us", v:"noshow"},
      {t:"Yes, it runs fine", v:"fine"},
      {t:"No, we don't take bookings", v:"none"}
    ]
  },
  {
    id:"leads", q:"When a new enquiry comes in, what happens?",
    opts:[
      {t:"We chase it manually, when we get to it", v:"manual"},
      {t:"Honestly, some slip through the cracks", v:"leak"},
      {t:"It's already handled automatically", v:"auto"}
    ]
  },
  {
    id:"hours", q:"Roughly how many hours a week go on repetitive admin?",
    opts:[
      {t:"Under 5", v:"low"},
      {t:"5–15", v:"med"},
      {t:"15+, it's a real drain", v:"high"},
      {t:"No idea, but too many", v:"unknown"}
    ]
  },
  {
    id:"tools", q:"How are you handling it today?",
    opts:[
      {t:"Manually / spreadsheets / notebooks", v:"manual"},
      {t:"A patchwork of apps that don't talk", v:"patchwork"},
      {t:"Fairly automated already", v:"auto"}
    ]
  }
];

/* ---------- Solution library, keyed by the main pain ---------- */
const SOLUTIONS = {
  booking:{
    title:"Booking & no-show automation",
    desc:"An automated booking flow that fills your diary, confirms and reminds customers, and chases the ones who go quiet, so the back-and-forth stops eating your day and empty slots stop costing you.",
    bullets:["Online booking that syncs straight to your calendar","Automatic confirmations, reminders & reschedules","No-show follow-ups that recover the revenue","Live in ~2 weeks, on your own accounts"]
  },
  leads:{
    title:"Lead-to-quote automation",
    desc:"Every enquiry gets an instant response, gets logged, and gets followed up on a schedule, so the leads you're quietly losing turn into booked, quoted work instead.",
    bullets:["Instant reply to every new enquiry","Nothing slips: every lead tracked to an outcome","Automated follow-up sequence until they book or decline","Turn website visitors into quotes on autopilot"]
  },
  invoicing:{
    title:"Invoicing & payment-link automation",
    desc:"Invoices go out the moment a job's done, payment links do the collecting, and reminders chase what's overdue, so you get paid faster without lifting a finger.",
    bullets:["Invoices raised & sent automatically","One-tap payment links for customers","Polite, automatic reminders on overdue accounts","Fewer late payments, less chasing"]
  },
  admin:{
    title:"Admin & reconciliation automation",
    desc:"The data entry, the banking, the reconciliation: the invisible work that eats hours, handed to a system that just does it, accurately, in the background.",
    bullets:["Data entry & record-keeping automated","Bank & transaction reconciliation handled","Fewer errors, no more end-of-week catch-up","Your team back on the work that actually pays"]
  },
  enquiries:{
    title:"Customer enquiry automation",
    desc:"The same questions, answered instantly and consistently, day or night, so your team stops repeating themselves and customers get a faster response.",
    bullets:["Instant answers to your most common questions","Consistent, on-brand responses 24/7","Only the real conversations reach a human","Faster replies without adding headcount"]
  }
};

/* ---------- Render questions ---------- */
const qContainer = document.getElementById("questions");
const answers = {};
QUESTIONS.forEach((question, qi) => {
  const block = document.createElement("div");
  block.className = "qblock";
  const hint = question.multi ? `<span class="qhint">select all that apply</span>` : "";
  block.innerHTML = `<div class="q"><span class="n">${String(qi+1).padStart(2,'0')}</span>${question.q}${hint}</div>`;
  const opts = document.createElement("div");
  opts.className = "opts";
  question.opts.forEach(o => {
    const label = document.createElement("label");
    label.className = "opt" + (question.multi ? " multi" : "");
    label.innerHTML = `<span class="dot"></span><span>${o.t}</span>`;
    label.addEventListener("click", () => {
      if(question.multi){
        const arr = answers[question.id] || (answers[question.id] = []);
        const idx = arr.indexOf(o.v);
        if(idx >= 0){ arr.splice(idx,1); label.classList.remove("sel"); }
        else { arr.push(o.v); label.classList.add("sel"); }
      } else {
        answers[question.id] = o.v;
        opts.querySelectorAll(".opt").forEach(el => el.classList.remove("sel"));
        label.classList.add("sel");
      }
    });
    opts.appendChild(label);
  });
  block.appendChild(opts);
  qContainer.appendChild(block);
});

/* ---------- Fit + recommendation logic ---------- */
function computeFit(){
  let score = 0;
  if(answers.hours === "high") score += 3;
  else if(answers.hours === "med" || answers.hours === "unknown") score += 2;
  else if(answers.hours === "low") score += 1;
  if(answers.tools === "manual") score += 2;
  else if(answers.tools === "patchwork") score += 2;
  if(answers.bookings === "noshow") score += 1;
  if(answers.leads === "manual" || answers.leads === "leak") score += 1;
  if(Array.isArray(answers.pain) && answers.pain.length >= 2) score += 1;
  return score;
}

function pickSolutions(){
  let keys = Array.isArray(answers.pain) ? answers.pain.slice() : (answers.pain ? [answers.pain] : []);
  if(keys.length === 0){
    if(answers.bookings === "noshow") keys.push("booking");
    else if(answers.leads === "leak" || answers.leads === "manual") keys.push("leads");
    else keys.push("admin");
  }
  const seen = {};
  const sols = keys.filter(k => SOLUTIONS[k] && !seen[k] && (seen[k] = 1)).map(k => SOLUTIONS[k]);
  return sols.length ? sols : [SOLUTIONS.admin];
}

/* ---------- Submit ---------- */
const err = document.getElementById("err");
document.getElementById("submitBtn").addEventListener("click", () => {
  const name = document.getElementById("name").value.trim();
  const email = document.getElementById("email").value.trim();
  const phone = document.getElementById("phone").value.trim();
  const business = document.getElementById("business").value.trim();

  if(!name || !email || !phone){ err.textContent = "Please add your name, email and contact number."; return; }
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)){ err.textContent = "That email doesn't look right. Mind checking it?"; return; }
  const answered = QUESTIONS.every(q => {
    const a = answers[q.id];
    return q.multi ? (Array.isArray(a) && a.length > 0) : !!a;
  });
  if(!answered){ err.textContent = "Please answer all the questions so I can point you to the right fix."; return; }
  err.textContent = "";

  const score = computeFit();
  const sols = pickSolutions();

  const badge = document.getElementById("verdictBadge");
  const vTitle = document.getElementById("verdictTitle");
  const vText = document.getElementById("verdictText");
  const first = name.split(" ")[0];

  if(answers.tools === "auto" && score <= 3){
    badge.textContent = "Worth a chat";
    vTitle.textContent = `You're already ahead, ${first}.`;
    vText.textContent = "You've automated a fair bit, so the wins here are sharper and more specific. A quick look would tell us if there's a worthwhile layer left to squeeze, or if you're already set.";
  } else if(score >= 5){
    badge.textContent = "Strong fit";
    vTitle.textContent = `There's real time to reclaim, ${first}.`;
    vText.textContent = "Based on your answers, repetitive work is quietly costing you hours and money every week. This is exactly the kind of business I build for, and there's a clear place to start.";
  } else {
    badge.textContent = "Good fit";
    vTitle.textContent = `Yes, there's something here for you, ${first}.`;
    vText.textContent = "You've got repetitive work worth removing. It may not be drowning you yet, but there's a straightforward first win that pays for itself.";
  }

  // recommendations (one card per selected pain)
  const wrap = document.getElementById("recoWrap");
  wrap.innerHTML = "";
  sols.forEach((sol, i) => {
    const card = document.createElement("div");
    card.className = "reco";
    card.style.marginTop = i === 0 ? "8px" : "14px";
    const lis = sol.bullets.map(b => `<li><svg viewBox="0 0 24 24"><path d="M5 12.5l4 4 10-11"/></svg><span>${b}</span></li>`).join("");
    const label = i === 0 ? "Where I&rsquo;d start" : "Also worth automating";
    card.innerHTML = `<div class="rl">${label}</div><div class="rt">${sol.title}</div><div class="rd">${sol.desc}</div><ul>${lis}</ul>`;
    wrap.appendChild(card);
  });

  // PLACEHOLDER lead delivery: mailto. Swap for Resend/Formspree POST later.
  const subject = encodeURIComponent(`Fit check for ${business || name}: ${sols[0].title}`);
  const bodyLines = [
    `Name: ${name}`,
    `Business: ${business || "-"}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    ``,
    `Recommended starting points: ${sols.map(s => s.title).join(", ")}`,
    ``,
    `Answers:`,
    ...QUESTIONS.map(q => {
      const a = answers[q.id];
      const labels = q.multi
        ? (a || []).map(v => (q.opts.find(o => o.v === v) || {}).t).filter(Boolean).join("; ")
        : ((q.opts.find(o => o.v === a) || {}).t || "");
      return `- ${q.q} ${labels}`;
    }),
    ``,
    `I'd like a no-pressure walkthrough.`
  ];
  const body = encodeURIComponent(bodyLines.join("\n"));
  document.getElementById("bookBtn").setAttribute("href", `mailto:tyler@wiseai.website?subject=${subject}&body=${body}`);

  // swap views
  document.getElementById("form").style.display = "none";
  const result = document.getElementById("result");
  result.classList.add("show");
  result.scrollIntoView({behavior:"smooth", block:"start"});
});

document.getElementById("againBtn").addEventListener("click", () => {
  Object.keys(answers).forEach(k => delete answers[k]);
  document.querySelectorAll(".opt.sel").forEach(el => el.classList.remove("sel"));
  ["name","business","email","phone"].forEach(id => { document.getElementById(id).value = ""; });
  err.textContent = "";
  document.getElementById("result").classList.remove("show");
  document.getElementById("form").style.display = "block";
  document.getElementById("form").scrollIntoView({behavior:"smooth", block:"start"});
});
