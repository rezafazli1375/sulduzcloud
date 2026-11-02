import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App.jsx';
import { ThemeProvider } from './lib/theme.jsx';
import './index.css';

/**
 * Last-resort screen for errors React cannot recover from (for example a
 * commit-phase DOM error raised by an extension that rewrites the page).
 * Those unmount the whole tree and would otherwise leave a blank page with
 * no explanation, so we render a plain-DOM card with the reason + reload.
 */
function showFatal(message) {
  if (typeof document === 'undefined' || document.getElementById('sc-fatal')) return;
  const wrap = document.createElement('div');
  wrap.id = 'sc-fatal';
  wrap.setAttribute('dir', 'rtl');
  wrap.style.cssText =
    'position:fixed;inset:0;z-index:2147483647;display:flex;align-items:center;justify-content:center;' +
    'padding:24px;background:#050811;color:#e2e8f0;font-family:Vazirmatn,system-ui,-apple-system,sans-serif';

  const box = document.createElement('div');
  box.style.cssText =
    'width:100%;max-width:440px;border:1px solid rgba(148,163,184,.18);border-radius:18px;' +
    'background:#0a1220;padding:26px;text-align:center';

  const icon = document.createElement('div');
  icon.style.cssText =
    'width:52px;height:52px;margin:0 auto 14px;border-radius:14px;background:rgba(244,63,94,.12);' +
    'color:#fda4af;display:flex;align-items:center;justify-content:center;font-size:26px;font-weight:700';
  icon.textContent = '!';

  const title = document.createElement('h1');
  title.style.cssText = 'margin:0;font-size:15px;font-weight:700;color:#fff';
  title.textContent = 'خطای غیرمنتظره / Unexpected error';

  const desc = document.createElement('p');
  desc.style.cssText = 'margin:10px 0 0;font-size:12px;line-height:2;color:#94a3b8';
  desc.textContent = 'صفحه به درستی نمایش داده نشد. لطفاً صفحه را دوباره بارگذاری کنید. اگر تکرار شد، متن خطای زیر را بفرستید.';

  const pre = document.createElement('pre');
  pre.setAttribute('dir', 'ltr');
  pre.style.cssText =
    'margin:14px 0 0;max-height:120px;overflow:auto;border:1px solid rgba(148,163,184,.14);' +
    'border-radius:10px;background:rgba(0,0,0,.35);padding:10px;text-align:left;' +
    'font:11px/1.7 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fda4af;white-space:pre-wrap';
  pre.textContent = String(message || 'Unknown error').slice(0, 400);

  const btn = document.createElement('button');
  btn.type = 'button';
  btn.textContent = 'بارگذاری مجدد / Reload';
  btn.style.cssText =
    'margin-top:18px;border:0;border-radius:12px;padding:10px 22px;cursor:pointer;' +
    'background:linear-gradient(135deg,#10b981,#06b6d4);color:#04120f;font:600 12px Vazirmatn,system-ui,sans-serif';
  btn.addEventListener('click', () => window.location.reload());

  box.appendChild(icon);
  box.appendChild(title);
  box.appendChild(desc);
  box.appendChild(pre);
  box.appendChild(btn);
  wrap.appendChild(box);
  document.body.appendChild(wrap);
}

window.addEventListener('error', (event) => {
  // Resource load failures have no `message`; extension-injected scripts are
  // not our problem either.
  if (!event || !event.message) return;
  const file = String(event.filename || '');
  if (/^(chrome|moz|safari|edge)-extension:\/\//.test(file)) return;
  if (event.message === 'Script error.' || event.message.includes('ResizeObserver loop')) return;
  showFatal(event.message);
});

window.addEventListener('unhandledrejection', (event) => {
  const reason = event && event.reason;
  console.error('[panel] unhandled rejection', reason);
});

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    <ThemeProvider>
      <App />
    </ThemeProvider>
  </React.StrictMode>
);
