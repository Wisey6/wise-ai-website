// Phone normalisation to E.164. The frontend (admin/os/js/api.js) mirrors this exactly.
//   04XXXXXXXX  -> +614XXXXXXXX
//   614XXXXXXXX -> +614XXXXXXXX
//   +6104XXXXXXXX (i.e. "+61 04...") -> +614XXXXXXXX
//   anything else that is not ^\+\d{8,15}$ -> null

export const AU_MOBILE = /^\+614\d{8}$/;

export function normalisePhone(raw: unknown): string | null {
  if (raw === null || raw === undefined) return null;
  let s = String(raw).replace(/[\s\-().]/g, "");
  if (!s) return null;
  if (/^04\d{8}$/.test(s)) s = "+61" + s.slice(1);
  else if (/^614\d{8}$/.test(s)) s = "+" + s;
  else if (/^\+6104\d{8}$/.test(s)) s = "+61" + s.slice(4);
  return /^\+\d{8,15}$/.test(s) ? s : null;
}
