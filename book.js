/* ===========================================================================
   Wise AI: Book a call
   - CAL_LINK is the ONE setting to change. Leave it empty until the Cal.com
     event exists; set it to the event path, e.g. "tyler-wise/intro".
     Empty: the page shows the "I'll call you" enquiry form only.
     Set:   the Cal.com inline booking calendar loads (from app.cal.com, only
            then), with the form underneath as "Prefer I call you?".
   - Prefill from the query string: ?name=&email=&phone= (and &business=).
   - The form POSTs JSON to the `lead-intake` edge function. If that fails,
     the visitor gets a ready-written email to Tyler instead.
   =========================================================================== */

const CAL_LINK = "";

const LEAD_INTAKE_URL =
  "https://adfgtlhryyyrqbbgbfmx.supabase.co/functions/v1/lead-intake";
const SOURCE = "wise-ai.au/book";

(function () {
  "use strict";

  /* ---------- helpers ---------- */
  const $ = (id) => document.getElementById(id);

  // Same rules as the lead-intake function: returns +61... / +<intl> or null.
  function normalisePhone(raw) {
    if (!raw) return null;
    let p = String(raw).replace(/[\s\-().]/g, "");
    if (/^\+6104\d{8}$/.test(p)) p = "+61" + p.slice(4);
    else if (/^04\d{8}$/.test(p)) p = "+61" + p.slice(1);
    else if (/^614\d{8}$/.test(p)) p = "+" + p;
    return /^\+\d{8,15}$/.test(p) ? p : null;
  }
  const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

  function readQuery() {
    const q = new URLSearchParams(window.location.search);
    const clip = (v, n) => (v || "").trim().slice(0, n);
    return {
      name: clip(q.get("name"), 120),
      email: clip(q.get("email"), 200),
      phone: clip(q.get("phone"), 40),
      business: clip(q.get("business"), 160)
    };
  }

  /* ---------- prefill ---------- */
  const pre = readQuery();
  ["name", "email", "phone", "business"].forEach((k) => {
    if (pre[k] && $(k)) $(k).value = pre[k];
  });

  /* ---------- Cal.com (only when CAL_LINK is set) ---------- */
  if (CAL_LINK) {
    $("calPanel").hidden = false;
    $("formTitle").textContent = "Prefer I call you?";
    $("formSub").textContent =
      "If none of those times suit, or you'd rather not pick one, leave your details and I'll ring you within one business day.";
    const orLine = document.createElement("div");
    orLine.className = "or-line";
    orLine.textContent = "or";
    $("formPanel").parentNode.insertBefore(orLine, $("formPanel"));
    loadCal();
  }

  function loadCal() {
    /* Official Cal.com embed snippet (embed.js is fetched from app.cal.com on first call). */
    (function (C, A, L) {
      let p = function (a, ar) { a.q.push(ar); };
      let d = C.document;
      C.Cal = C.Cal || function () {
        let cal = C.Cal; let ar = arguments;
        if (!cal.loaded) {
          cal.ns = {}; cal.q = cal.q || [];
          d.head.appendChild(d.createElement("script")).src = A;
          cal.loaded = true;
        }
        if (ar[0] === L) {
          const api = function () { p(api, arguments); };
          const namespace = ar[1];
          api.q = api.q || [];
          if (typeof namespace === "string") {
            cal.ns[namespace] = cal.ns[namespace] || api;
            p(cal.ns[namespace], ar);
            p(cal, ["initNamespace", namespace]);
          } else p(cal, ar);
          return;
        }
        p(cal, ar);
      };
    })(window, "https://app.cal.com/embed/embed.js", "init");

    const config = { layout: "month_view", theme: "light" };
    if (pre.name) config.name = pre.name;
    if (pre.email) config.email = pre.email;
    if (pre.phone) config.attendeePhoneNumber = normalisePhone(pre.phone) || pre.phone;

    window.Cal("init", "wise", { origin: "https://cal.com" });
    window.Cal.ns.wise("inline", {
      elementOrSelector: "#calInline",
      calLink: CAL_LINK,
      config: config
    });
    window.Cal.ns.wise("ui", {
      theme: "light",
      hideEventTypeDetails: false,
      layout: "month_view",
      cssVarsPerTheme: { light: { "cal-brand": "#0A0E11" } }
    });
  }

  /* ---------- enquiry form ---------- */
  const form = $("leadForm");
  const err = $("formErr");
  const btn = $("sendBtn");
  const fields = ["name", "business", "phone", "email", "message"];

  function value(id) { return ($(id).value || "").trim(); }

  function markInvalid(ids) {
    fields.forEach((id) => $(id).removeAttribute("aria-invalid"));
    ids.forEach((id) => $(id).setAttribute("aria-invalid", "true"));
    if (ids[0]) $(ids[0]).focus();
  }

  function validate() {
    const name = value("name"), email = value("email"), phone = value("phone");
    if (!name) { markInvalid(["name"]); return "I just need your name."; }
    if (!email && !phone) { markInvalid(["phone", "email"]); return "Add a phone number or an email so I can reach you."; }
    if (email && !EMAIL_RE.test(email)) { markInvalid(["email"]); return "That email doesn't look right, mind checking it?"; }
    // A landline or odd format can't be texted, so it needs an email beside it (it's kept in the note).
    if (phone && !normalisePhone(phone) && !email) { markInvalid(["phone", "email"]); return "I can't read that number. Use a mobile like 0400 000 000, or add an email as well."; }
    markInvalid([]);
    return "";
  }

  function mailtoHref() {
    const name = value("name"), business = value("business");
    const subject = "Call request" + (business ? ", " + business : name ? ", " + name : "");
    const body = [
      "Hi Tyler,",
      "",
      "I'd like a quick call.",
      "",
      "Name: " + (name || "-"),
      "Business: " + (business || "-"),
      "Phone: " + (value("phone") || "-"),
      "Email: " + (value("email") || "-"),
      "",
      "What I'd like help with: " + (value("message") || "-")
    ].join("\n");
    return "mailto:tyler@wise-ai.au?subject=" + encodeURIComponent(subject) + "&body=" + encodeURIComponent(body);
  }

  function showOk() {
    const first = value("name").split(/\s+/)[0];
    $("doneTitle").textContent = first ? `Thanks, ${first}. I've got your details.` : "Thanks. I've got your details.";
    form.hidden = true;
    $("doneFail").hidden = true;
    $("doneOk").hidden = false;
    $("doneOk").focus({ preventScroll: true });
    $("doneOk").scrollIntoView({ behavior: "smooth", block: "center" });
  }

  function showFail() {
    $("failMail").setAttribute("href", mailtoHref());
    $("doneFail").hidden = false;
    $("doneFail").focus({ preventScroll: true });
    $("doneFail").scrollIntoView({ behavior: "smooth", block: "center" });
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

    // Honeypot: a person never sees this field. If it's filled, quietly do nothing.
    if (value("website")) { showOk(); return; }

    const message = value("message");
    const rawPhone = value("phone");
    const phoneNote = rawPhone && !normalisePhone(rawPhone) ? " Phone as typed: " + rawPhone + "." : "";
    const payload = {
      name: value("name"),
      email: value("email") || null,
      phone: normalisePhone(value("phone")),
      business: value("business") || null,
      source: SOURCE,
      summary: "Asked for a call from the booking page." + phoneNote + (message ? " What they want help with: " + message : ""),
      website: ""
    };

    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Sending...";
    const ok = await send(payload);
    btn.disabled = false;
    btn.textContent = label;
    if (ok) showOk(); else showFail();
  });

  $("retryBtn").addEventListener("click", () => {
    $("doneFail").hidden = true;
    form.requestSubmit ? form.requestSubmit() : btn.click();
  });

  // Clear the red outline as soon as someone starts fixing a field.
  fields.forEach((id) => $(id).addEventListener("input", () => $(id).removeAttribute("aria-invalid")));
})();
