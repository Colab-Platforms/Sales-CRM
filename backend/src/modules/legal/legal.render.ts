import { LEGAL_DETAILS, type LegalPage, type LegalSection } from "./legal.content.js";

const escapeHtml = (value: string): string =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const slug = (heading: string): string => heading.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");

const renderSection = (s: LegalSection, level: 2 | 3): string => {
  const tag = `h${level}`;
  const body = s.paragraphs.map((p) => `<p>${escapeHtml(p)}</p>`).join("");
  const nested = (s.subsections ?? []).map((sub) => renderSection(sub, 3)).join("");
  return `<section id="${slug(s.heading)}"><${tag}>${escapeHtml(s.heading)}</${tag}>${body}${nested}</section>`;
};

// Colors mirror the CRM's theme tokens (frontend/app/globals.css: --paper, --ink, --primary, --border, --card) as hex
// so the page renders the same in every browser. System fonts only, no scripts and no external requests - the page
// works under helmet's default Content-Security-Policy.
const STYLES = `
:root{--paper:#faf9f5;--ink:#1f2437;--muted:#5f6577;--primary:#3646c8;--border:#dcdfe8;--card:#fff}
@media (prefers-color-scheme:dark){:root{--paper:#14161f;--ink:#f2f1ec;--muted:#a9adbb;--primary:#8d9bff;--border:#2b2f3d;--card:#1c1f2b}}
*{box-sizing:border-box}
body{margin:0;background:var(--paper);color:var(--ink);font:16px/1.7 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}
header{border-bottom:1px solid var(--border);background:var(--card)}
.wrap{max-width:820px;margin:0 auto;padding:0 20px}
header .wrap{display:flex;align-items:center;justify-content:space-between;gap:16px;padding:16px 20px;flex-wrap:wrap}
.brand{font-weight:800;font-size:1.15rem;color:var(--primary);text-decoration:none}
nav a{color:var(--muted);text-decoration:none;margin-left:16px;font-size:.95rem}
nav a:hover,nav a[aria-current]{color:var(--primary)}
main{padding:36px 0 48px}
h1{font-size:2rem;line-height:1.25;margin:0 0 6px}
h2{font-size:1.3rem;margin:36px 0 8px;padding-top:8px;border-top:1px solid var(--border)}
h3{font-size:1.05rem;margin:22px 0 4px}
p{margin:8px 0}
.meta{color:var(--muted);font-size:.92rem;margin-bottom:8px}
.card{background:var(--card);border:1px solid var(--border);border-radius:12px;padding:16px 20px;margin:20px 0;font-size:.95rem}
.card dt{font-weight:700;margin-top:8px}.card dd{margin:0;color:var(--muted)}
footer{border-top:1px solid var(--border);color:var(--muted);font-size:.9rem;padding:20px 0}
@media (max-width:520px){h1{font-size:1.6rem}nav a{margin:0 16px 0 0}}
`;

export function renderLegalPage(page: LegalPage): string {
  const other = page.path === "/privacy-policy" ? { href: "/terms-of-service", label: "Terms of Service" } : { href: "/privacy-policy", label: "Privacy Policy" };
  const heading = page.title.split(" | ")[0];
  const details = [
    ["Company", LEGAL_DETAILS.companyLegalName],
    ["Registered address", LEGAL_DETAILS.registeredAddress],
    ["Support", LEGAL_DETAILS.supportEmail],
    ["Grievance officer", LEGAL_DETAILS.grievanceOfficer],
  ]
    .map(([term, value]) => `<dt>${escapeHtml(term)}</dt><dd>${escapeHtml(value)}</dd>`)
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(page.title)}</title>
<meta name="description" content="${escapeHtml(page.description)}">
<meta name="robots" content="index,follow">
<style>${STYLES}</style>
</head>
<body>
<header><div class="wrap"><a class="brand" href="/privacy-policy">${escapeHtml(LEGAL_DETAILS.platformName)}</a>
<nav><a href="${other.href}">${other.label}</a></nav></div></header>
<main class="wrap">
<h1>${escapeHtml(heading)}</h1>
<p class="meta">Last updated: ${escapeHtml(LEGAL_DETAILS.lastUpdated)}</p>
<dl class="card">${details}</dl>
${page.sections.map((s) => renderSection(s, 2)).join("\n")}
</main>
<footer><div class="wrap">&copy; ${escapeHtml(LEGAL_DETAILS.companyLegalName)} &middot; <a href="/privacy-policy" style="color:inherit">Privacy Policy</a> &middot; <a href="/terms-of-service" style="color:inherit">Terms of Service</a></div></footer>
</body>
</html>
`;
}
