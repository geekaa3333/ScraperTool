/**
 * My Scraping History.
 *
 * Self-contained on purpose: it shares the stylesheet but none of the scraper
 * UI's code, so adding accounts and history cannot disturb the scraping pages.
 *
 * The CSRF token is read from the readable cookie and echoed in a header. It is
 * not a credential — the session cookie is HttpOnly and cannot be read here —
 * but every mutating request is rejected without it.
 */
(() => {
  'use strict';

  const CSRF_COOKIE = 'sellerctrl_csrf';
  const PAGE_SIZE = 25;

  const $ = (id) => document.getElementById(id);
  const state = {
    mode: 'login',
    offset: 0,
    total: 0,
    jobs: [],
    marketplaces: [],
    sort: { key: 'createdAt', dir: 'desc' },
  };

  // -------------------------------------------------------------------------
  // Helpers
  // -------------------------------------------------------------------------

  function csrfToken() {
    const match = document.cookie.match(new RegExp(`(?:^|; )${CSRF_COOKIE}=([^;]*)`));
    return match ? decodeURIComponent(match[1]) : '';
  }

  async function api(path, { method = 'GET', body } = {}) {
    const headers = {};
    if (body !== undefined) headers['content-type'] = 'application/json';
    const token = csrfToken();
    if (token) headers['x-csrf-token'] = token;

    const res = await fetch(path, {
      method,
      headers,
      credentials: 'same-origin',
      body: body === undefined ? undefined : JSON.stringify(body),
    });

    if (res.status === 401) {
      showAuth('login');
      throw new Error('Not signed in');
    }
    const text = await res.text();
    let json = null;
    try { json = JSON.parse(text); } catch { /* non-JSON body */ }
    if (!res.ok) {
      const error = new Error((json && json.error) || `Request failed (${res.status})`);
      error.status = res.status;
      throw error;
    }
    return json;
  }

  function show(node, visible) {
    node.classList.toggle('hidden', !visible);
  }

  function banner(node, message, isError = true) {
    node.textContent = message;
    node.classList.remove('alert-error', 'alert-ok');
    node.classList.add(isError ? 'alert-error' : 'alert-ok');
    show(node, true);
  }

  const clearBanner = (node) => { node.textContent = ''; show(node, false); };

  function fmtDate(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '—' : d.toLocaleDateString();
  }

  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString();
  }

  const shortId = (id) => (id ? String(id).slice(0, 8) : '—');
  const num = (n) => (typeof n === 'number' ? n.toLocaleString() : (n ?? 0).toLocaleString());

  // -------------------------------------------------------------------------
  // Auth view
  // -------------------------------------------------------------------------

  function showAuth(mode) {
    state.mode = mode;
    show($('auth-view'), true);
    show($('history-view'), false);
    show($('detail'), false);

    const registering = mode === 'register';
    $('auth-title').textContent = registering ? 'Create your account' : 'Sign in';
    $('auth-sub').textContent = registering
      ? 'Your jobs, uploads and reports stay private to your account.'
      : 'Access your scraping history and reports.';
    show($('name-field'), registering);
    $('auth-submit').textContent = registering ? 'Create account' : 'Sign in';
    $('auth-toggle').textContent = registering ? 'I already have an account' : 'Create an account';
    show($('auth-forgot'), !registering);
    $('password').setAttribute('autocomplete', registering ? 'new-password' : 'current-password');
    clearBanner($('auth-error'));
  }

  async function submitAuth(event) {
    event.preventDefault();
    clearBanner($('auth-error'));

    const email = $('email').value.trim();
    const password = $('password').value;
    const displayName = $('displayName').value.trim();
    const button = $('auth-submit');
    button.disabled = true;

    try {
      if (state.mode === 'register') {
        await api('/api/auth/register', {
          method: 'POST',
          body: { email, password, displayName },
        });
        // Registration does not sign in; go straight to sign-in with the same
        // credentials so the user is not asked to type the password twice.
        state.mode = 'login';
      }
      await api('/api/auth/login', { method: 'POST', body: { email, password } });
      await enterApp();
    } catch (error) {
      banner($('auth-error'), error.message);
      // Surface the policy rather than guessing, but never echo the password.
      if (error.status === 400 && /12 characters/.test(error.message)) {
        $('password').setAttribute('minlength', '12');
      }
    } finally {
      button.disabled = false;
      $('password').value = '';
    }
  }

  async function requestReset() {
    const email = $('email').value.trim();
    if (!email) {
      banner($('auth-error'), 'Enter your email address first.');
      return;
    }
    try {
      const result = await api('/api/auth/password-reset', { method: 'POST', body: { email } });
      // The response is deliberately identical whether or not the account
      // exists, so nothing here reveals whether the address is registered.
      banner($('auth-error'), '', false);
      clearBanner($('auth-error'));
      banner($('auth-ok'), result.message, false);
    } catch (error) {
      banner($('auth-error'), error.message);
    }
  }

  async function enterApp() {
    const me = await api('/api/auth/me');
    show($('auth-view'), false);
    show($('history-view'), true);
    show($('detail'), false);
    $('who').textContent = `${me.displayName} · ${me.email}${me.role === 'admin' ? ' · administrator' : ''}`;
    await loadMarketplaces();
    await loadHistory();
  }

  async function loadMarketplaces() {
    const select = $('f-market');
    try {
      const result = await api('/api/marketplaces');
      state.marketplaces = result.marketplaces;
      select.innerHTML = '<option value="">All marketplaces</option>';
      for (const market of result.marketplaces) {
        const option = document.createElement('option');
        option.value = market.id;
        option.textContent = `${market.label} (${market.domain})`;
        select.appendChild(option);
      }
    } catch {
      // The list is a convenience; the history still loads without it.
    }
  }

  // -------------------------------------------------------------------------
  // History
  // -------------------------------------------------------------------------

  function query() {
    const params = new URLSearchParams();
    const q = $('q').value.trim();
    const marketplace = $('f-market').value;
    const status = $('f-status').value;
    const from = $('f-from').value;
    const to = $('f-to').value;

    if (q) params.set('q', q);
    if (marketplace) params.set('marketplace', marketplace);
    if (status) params.set('status', status);
    if (from) params.set('from', new Date(`${from}T00:00:00`).toISOString());
    // An inclusive end date becomes an exclusive upper bound on the next day,
    // so a job run on the selected day is still included.
    if (to) params.set('to', new Date(`${to}T23:59:59.999Z`).toISOString());
    const sort = $('f-sort').value;
    if (sort) params.set('sort', sort);
    params.set('limit', String(PAGE_SIZE));
    params.set('offset', String(state.offset));
    return params.toString();
  }

  async function loadHistory() {
    clearBanner($('history-error'));
    const tbody = $('rows');
    tbody.innerHTML = '<tr><td colspan="12" class="muted">Loading…</td></tr>';
    try {
      const result = await api(`/api/queue/jobs?${query()}`);
      state.jobs = result.jobs;
      state.total = result.total;
      renderRows();
    } catch (error) {
      tbody.innerHTML = '';
      banner($('history-error'), error.message);
    }
  }

  function renderRows() {
    const tbody = $('rows');

    if (state.jobs.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="muted">No scraping jobs match these filters.</td></tr>';
    } else {
      tbody.innerHTML = '';
      for (const job of state.jobs) {
        const tr = document.createElement('tr');
        const created = job.createdAt;
        const markets = (job.marketplaces || []).join(', ') || '—';

        // A job offers a download only when a report was actually archived for
        // it; the button is shown per report type below.
        const downloads = job.reportCount > 0
          ? `<span class="muted">${job.reportCount} file${job.reportCount === 1 ? '' : 's'}</span>`
          : '<span class="muted">none yet</span>';

        tr.innerHTML = `
          <td>${fmtDate(created)}</td>
          <td class="muted">${fmtTime(created)}</td>
          <td title="${job.jobId}">${escapeHtml(job.jobName || shortId(job.jobId))}</td>
          <td>${escapeHtml(markets)}</td>
          <td class="num">${job.marketplaceCount}</td>
          <td class="num">${num(job.totalInputRows)}</td>
          <td class="num">${num(job.uniqueAsins)}</td>
          <td class="num">${num(job.totalProductMarketplaceRecords)}</td>
          <td class="num">${num(job.totalSellerOffers)}</td>
          <td><span class="pill pill-${job.status}">${job.status}</span></td>
          <td>${downloads}</td>
          <td><button class="btn" data-job="${job.jobId}">Details</button></td>`;
        tbody.appendChild(tr);
      }
    }

    const shown = state.jobs.length;
    $('page-info').textContent = state.total === 0
      ? 'No jobs'
      : `${state.offset + 1}–${state.offset + shown} of ${num(state.total)}`;
    $('prev').disabled = state.offset === 0;
    $('next').disabled = state.offset + PAGE_SIZE >= state.total;
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>"']/g, (c) => (
      { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
    ));
  }

  // -------------------------------------------------------------------------
  // Job details
  // -------------------------------------------------------------------------

  async function openDetail(jobId) {
    clearBanner($('history-error'));
    show($('detail'), true);
    $('detail-facts').innerHTML = '<p class="muted">Loading…</p>';
    $('detail-reports').innerHTML = '';
    $('detail-files').innerHTML = '';
    $('detail-progress').innerHTML = '';

    let detail;
    try {
      detail = await api(`/api/queue/jobs/${jobId}`);
    } catch (error) {
      $('detail-facts').innerHTML = `<p class="muted">${escapeHtml(error.message)}</p>`;
      return;
    }

    const job = detail.job;
    $('detail-title').textContent = job.jobName || `Job ${shortId(job.jobId)}`;

    const facts = [
      ['Job ID', job.jobId],
      ['Date', `${fmtDate(job.createdAt)} ${fmtTime(job.createdAt)}`],
      ['Mode', job.scrapingMode],
      ['Status', job.status],
      ['Marketplaces', (job.marketplaces || []).join(', ') || '—'],
      ['Uploaded rows', num(job.totalInputRows)],
      ['Unique ASINs', num(job.uniqueAsins)],
      ['Product records', num(job.totalProductMarketplaceRecords)],
      ['Successful', num(job.successfulRecords)],
      ['Failed', num(job.failedRecords)],
      ['Not found', num(job.notFoundRecords)],
      ['Restricted', num(job.restrictedRecords)],
      ['Seller offers', num(job.totalSellerOffers)],
      ['Started', fmtDate(job.startedAt)],
      ['Finished', fmtDate(job.completedAt)],
    ];
    $('detail-facts').innerHTML = facts
      .map(([k, v]) => `<div><strong>${escapeHtml(k)}</strong>${escapeHtml(v ?? '—')}</div>`)
      .join('');

    const progress = detail.progress || [];
    $('detail-progress').innerHTML = progress.length === 0
      ? '<tr><td class="muted">No items recorded.</td></tr>'
      : `<thead><tr><th>Marketplace</th><th class="num">Input</th><th class="num">Unique</th>
              <th class="num">Done</th><th class="num">Failed</th><th class="num">Not found</th>
              <th class="num">Pending</th></tr></thead><tbody>` +
        progress.map((p) => `<tr><td>${escapeHtml(p.marketplaceId)}</td>
          <td class="num">${num(p.inputAsinCount)}</td>
          <td class="num">${num(p.uniqueAsinCount)}</td>
          <td class="num">${num(p.completedCount)}</td>
          <td class="num">${num(p.failedCount)}</td>
          <td class="num">${num(p.notFoundCount)}</td>
          <td class="num">${num(p.pendingCount)}</td></tr>`).join('') +
        '</tbody>';

    const quality = detail.quality || {};
    $('detail-quality').textContent = quality.sellerOffers
      ? `${num(quality.offersWithPrice)} of ${num(quality.sellerOffers)} seller offers carry a price ` +
        `(${quality.priceCoveragePercent}%). ${num(quality.offersWithoutPrice)} have none — ` +
        'these are reported as unavailable rather than filled in with a guess.'
      : 'No seller offers have been captured for this job yet.';

    const files = detail.files || [];
    $('detail-files').innerHTML = files.length === 0
      ? '<li class="muted">No uploaded files recorded.</li>'
      : files.map((f) => `<li>${escapeHtml(f.original_filename)} — ${escapeHtml(f.marketplace_id ?? '?')}
          · ${num(f.row_count)} rows · ${fmtDate(f.uploaded_at)}</li>`).join('');

    renderReports(detail.reports || [], job.jobId);
  }

  function renderReports(reports, jobId) {
    const container = $('detail-reports');
    const available = reports.filter((r) => r.status === 'AVAILABLE');

    if (available.length === 0) {
      container.innerHTML = '<span class="muted">No reports generated yet.</span>';
      return;
    }
    container.innerHTML = available.map((report) => {
      // A plain link to the authenticated download route: the browser carries
      // the session cookie, the server re-checks ownership, and no token ever
      // appears in the page.
      const href = `/api/reports/${report.report_id}/download`;
      const label = report.report_type === 'tsv' ? 'Download TSV' : 'Download Excel';
      return `<a class="btn" href="${href}">${label}</a>`;
    }).join('') + `<span class="muted" style="margin-left:.5rem;">${available.length} file(s) for this job ${shortId(jobId)}</span>`;
  }

  async function regenerate(jobId) {
    const button = $('detail-regen');
    button.disabled = true;
    button.textContent = 'Generating…';
    try {
      const result = await api(`/api/queue/jobs/${jobId}/reports`, { method: 'POST' });
      if (result.available === 0) {
        banner($('history-error'), 'No reports could be generated for this job.');
      } else {
        await openDetail(jobId);
        await loadHistory();
      }
    } catch (error) {
      banner($('history-error'), error.message);
    } finally {
      button.disabled = false;
      button.textContent = 'Generate reports';
    }
  }

  // -------------------------------------------------------------------------
  // Wiring
  // -------------------------------------------------------------------------

  async function signOut() {
    try {
      await api('/api/auth/logout', { method: 'POST' });
    } catch {
      // Even if the call fails, drop to the signed-out view rather than leaving
      // a stale session on screen.
    }
    $('email').value = '';
    $('password').value = '';
    showAuth('login');
  }

  document.addEventListener('DOMContentLoaded', () => {
    $('auth-form').addEventListener('submit', submitAuth);
    $('auth-toggle').addEventListener('click', () => showAuth(state.mode === 'login' ? 'register' : 'login'));
    $('auth-forgot').addEventListener('click', requestReset);
    $('logout').addEventListener('click', signOut);

    $('filters').addEventListener('submit', (event) => {
      event.preventDefault();
      state.offset = 0;
      loadHistory();
    });
    $('f-clear').addEventListener('click', () => {
      $('q').value = '';
      $('f-market').value = '';
      $('f-status').value = '';
      $('f-from').value = '';
      $('f-to').value = '';
      // Reset to the default order too, so Clear genuinely returns to the
      // starting view rather than leaving a sort the user did not choose.
      $('f-sort').value = 'newest';
      state.offset = 0;
      loadHistory();
    });

    $('prev').addEventListener('click', () => {
      state.offset = Math.max(0, state.offset - PAGE_SIZE);
      loadHistory();
    });
    $('next').addEventListener('click', () => {
      state.offset += PAGE_SIZE;
      loadHistory();
    });

    $('rows').addEventListener('click', (event) => {
      const button = event.target.closest('button[data-job]');
      if (button) openDetail(button.dataset.job);
    });

    $('detail-close').addEventListener('click', () => show($('detail'), false));
    $('detail').addEventListener('click', (event) => {
      if (event.target === $('detail')) show($('detail'), false);
    });
    document.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') show($('detail'), false);
    });
    $('detail-regen').addEventListener('click', () => {
      const title = $('detail-title').textContent;
      const match = state.jobs.find((j) => (j.jobName || `Job ${shortId(j.jobId)}`) === title);
      if (match) regenerate(match.jobId);
    });

    // Resume an existing session if the cookie is still valid, so returning to
    // this page does not require signing in again.
    api('/api/auth/me')
      .then(enterApp)
      .catch(() => showAuth('login'));
  });
})();