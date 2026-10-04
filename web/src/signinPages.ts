// Sign-in pages in a task browser (TaskBrowser.tsx shows SigninWindowNote on them). Google and some other sites refuse a
// sign-in in a headless task browser. On a known sign-in page the view offers the template's normal Chrome window
// (server/browser-signins.ts signinWindow). refused: the page is Google's answer to a refused sign-in: the
// "Error 500 (Server Error)!!1" page on accounts.google.com, the /signin/rejected page, or "Couldn't sign you in".
// target: the address that opens in the normal window. For Google it is the service in the continue parameter (for
// example https://mail.google.com/), or https://accounts.google.com/, because the address of a refused step does not
// work again. For other sites it is the page itself.
export interface SigninPage { site: string; refused: boolean; target: string }

const HOSTS: { test: (host: string, path: string) => boolean; site: string }[] = [
  { test: h => h === 'accounts.google.com', site: 'google.com' },
  { test: h => h === 'login.microsoftonline.com' || h === 'login.live.com' || h === 'login.microsoft.com', site: 'microsoft' },
  { test: (h, p) => h === 'github.com' && /^\/(login|session|sessions\/)/.test(p), site: 'github.com' },
  { test: h => /(^|\.)okta\.com$/.test(h) || /(^|\.)oktapreview\.com$/.test(h), site: 'okta' },
];

export function signinPage(url: string, title = ''): SigninPage | null {
  let u: URL;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol !== 'https:') return null;
  const host = u.hostname.toLowerCase();
  const hit = HOSTS.find(h => h.test(host, u.pathname));
  if (!hit) return null;
  if (hit.site !== 'google.com') return { site: host, refused: false, target: u.href };
  const refused = /^Error 5\d\d/.test(title) || /\/signin\/rejected/.test(u.pathname) || /couldn.t sign you in/i.test(title);
  const next = u.searchParams.get('continue') || '';
  const target = /^https:\/\/[a-z0-9.-]+\.google\.com(\/|$)/i.test(next) ? next : 'https://accounts.google.com/';
  return { site: 'google.com', refused, target };
}
