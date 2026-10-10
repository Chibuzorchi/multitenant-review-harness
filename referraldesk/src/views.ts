import type { AuthUser } from './auth';
import { APP_VERSION, config } from './config';
import { patientModuleEnabled } from './features';
import { can } from './policy';

export function esc(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const CSS = `
*{box-sizing:border-box}body{margin:0;font:15px/1.45 system-ui,-apple-system,"Segoe UI",sans-serif;color:#16263a;background:#f4f7fa}
header{background:#0f3d5c;color:#fff;padding:10px 20px;display:flex;flex-wrap:wrap;gap:8px 20px;align-items:center}
header strong{font-size:17px}nav{display:flex;flex-wrap:wrap;gap:4px 14px;flex:1}nav a{color:#cfe8f5;text-decoration:none}nav a:hover{color:#fff}
header form{margin:0}main{max-width:1100px;margin:0 auto;padding:20px}h1{font-size:22px;margin:0 0 14px}h2{font-size:17px;margin:22px 0 8px}
.wrap{overflow-x:auto;background:#fff;border:1px solid #d9e2ea;border-radius:6px}table{border-collapse:collapse;width:100%}
th,td{text-align:left;padding:7px 10px;border-bottom:1px solid #e6edf2;white-space:nowrap}th{background:#eef4f8;font-weight:600}
td.wrapcell{white-space:normal}form.inline{display:flex;flex-wrap:wrap;gap:8px;align-items:end;margin:10px 0}
label{display:flex;flex-direction:column;font-size:13px;color:#4a5d70;gap:3px}
input,select,button{font:inherit;padding:6px 9px;border:1px solid #b9c7d3;border-radius:5px;background:#fff}
button{background:#0b6fa4;color:#fff;border-color:#0b6fa4;cursor:pointer}header button{background:transparent;border-color:#7fb4d1}
.tiles{display:grid;grid-template-columns:repeat(auto-fit,minmax(150px,1fr));gap:12px}.tile{background:#fff;border:1px solid #d9e2ea;border-radius:6px;padding:12px}
.tile b{display:block;font-size:24px}.muted{color:#5c6f82;font-size:13px}.card{background:#fff;border:1px solid #d9e2ea;border-radius:6px;padding:16px;max-width:380px}
.error{color:#a12626}footer{max-width:1100px;margin:0 auto;padding:10px 20px 30px}
`;

export function layout(options: { title: string; page: string; user?: AuthUser; body: string }): string {
  const { user } = options;
  const links: string[] = [];
  if (user) {
    links.push('<a href="/">Dashboard</a>', '<a href="/referral-sources">Referral sources</a>');
    if (can(user.role, 'activities.read')) links.push('<a href="/activities">Activities</a>');
    links.push('<a href="/referrals">Referrals</a>');
    if (can(user.role, 'reports.read')) links.push('<a href="/reports">Reports</a>');
    if (can(user.role, 'users.admin')) links.push('<a href="/admin/users">Users</a>');
    if (patientModuleEnabled() && can(user.role, 'patients.access')) links.push('<a href="/patients">Patients</a>');
  }
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(options.title)} · ReferralDesk</title><style>${CSS}</style></head>
<body><header><strong>ReferralDesk</strong><nav aria-label="Main">${links.join('')}</nav>${
    user
      ? `<span class="muted" style="color:#cfe8f5" data-testid="whoami">${esc(user.name)} · ${esc(user.role)}</span>
<form method="post" action="/logout"><button type="submit" data-testid="logout">Sign out</button></form>`
      : ''
  }</header>
<main data-page="${esc(options.page)}">${options.body}</main>
<footer class="muted">ReferralDesk ${APP_VERSION} · build ${esc(config.buildSha.slice(0, 12))} · fictional demonstration data</footer></body></html>`;
}

export function table(options: { columns: Array<[key: string, label: string]>; rows: Array<Record<string, unknown>>; attrs?: string; rowAttrs?: (row: Record<string, unknown>) => string; link?: (row: Record<string, unknown>) => string | null }): string {
  const head = options.columns.map(([, label]) => `<th>${esc(label)}</th>`).join('');
  const body = options.rows
    .map((row) => {
      const cells = options.columns
        .map(([key], index) => {
          const href = index === 0 && options.link ? options.link(row) : null;
          return `<td data-col="${esc(key)}">${href ? `<a href="${esc(href)}">${esc(row[key])}</a>` : esc(row[key])}</td>`;
        })
        .join('');
      return `<tr ${options.rowAttrs ? options.rowAttrs(row) : ''}>${cells}</tr>`;
    })
    .join('');
  return `<div class="wrap"><table ${options.attrs ?? ''}><thead><tr>${head}</tr></thead><tbody>${body || `<tr><td colspan="${options.columns.length}" class="muted">No rows</td></tr>`}</tbody></table></div>`;
}
