/**
 * Scraper Tool dashboard.
 *
 * Talks only to the local server's REST API. No paid service, no API key.
 *
 * One rule runs through the rendering code: **a field Amazon did not show is
 * rendered as "Not Available", never as a zero or a blank.** A seller with no
 * delivery estimate must not look like a seller delivering today.
 */

const $ = (id) => document.getElementById(id);

const state = {
  product: null,
  destination: null,
  destinations: [],
  sort: 'total',
  marketplace: 'eg',
  marketplaces: [],
};

const NA = 'Not Available';

// ── helpers ────────────────────────────────────────────────

/** Render a value, or an explicit "Not Available" when it is absent. */
function show(value, formatter) {
  if (value === null || value === undefined || value === '') {
    return `<span class="na">${NA}</span>`;
  }
  return formatter ? formatter(value) : escapeHtml(String(value));
}

function escapeHtml(value) {
  return String(value).replace(/[&<>"']/g, (char) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  })[char]);
}

function money(amount, currency) {
  if (amount === null || amount === undefined) return null;
  const symbol = currency === 'EGP' ? 'EGP ' : currency ? `${currency} ` : '';
  return `${symbol}${Number(amount).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** Show a busy state on a button while work is in flight. */
function busy(button, isBusy, label) {
  button.disabled = isBusy;
  if (isBusy) {
    button.dataset.original = button.textContent;
    button.innerHTML = `<span class="spinner"></span>${label}`;
  } else if (button.dataset.original) {
    button.textContent = button.dataset.original;
  }
}

function banner(kind, title, detail) {
  const el = $('banner');
  el.className = `banner ${kind}`;
  el.innerHTML = `<strong>${escapeHtml(title)}</strong>${detail ? escapeHtml(detail) : ''}`;
  el.classList.remove('hidden');
}

function clearBanner() {
  $('banner').classList.add('hidden');
}

// ── boot ───────────────────────────────────────────────────

async function init() {
  try {
    const health = await (await fetch('/api/health')).json();
    const blocked = health.blockedForSeconds > 0;
    $('status').innerHTML = blocked
      ? `<span class="blocked">Scraping paused (${health.blockedForSeconds}s)</span><br>${escapeHtml(health.blockReason ?? '')}`
      : `<span class="ok">● ${health.marketplaceCount ?? state.marketplaces.length ?? 0} marketplaces</span><br>cache ${health.cacheTtlSeconds}s · min ${health.pacing?.minIntervalMs ?? 4000}ms`;
  } catch {
    $('status').textContent = 'server unreachable';
  }

  // Real database counts, never estimates.
  await loadDashboard();

  // Marketplace catalogue drives every selector in the UI.
  try {
    const payload = await (await fetch('/api/marketplaces')).json();
    state.marketplaces = payload.marketplaces ?? [];
    state.marketplace = payload.default ?? 'eg';
  } catch {
    state.marketplaces = [];
  }

  const options = state.marketplaces
    .map((mp) => `<option value="${escapeHtml(mp.id)}">${escapeHtml(mp.label)} — ${escapeHtml(mp.domain)}</option>`)
    .join('');

  $('marketplace').innerHTML = options;
  $('marketplace').value = state.marketplace;
  $('marketplace').addEventListener('change', () => {
    state.marketplace = $('marketplace').value;
  });

  // A pasted full URL overrides the dropdown, and says so.
  $('asin').addEventListener('input', syncDetectedMarketplace);

  const { destinations } = await (await fetch('/api/destinations')).json();
  state.destinations = destinations;

  // The single-ASIN selector follows the same country rule as the bulk one:
  // only destinations valid for the chosen marketplace are offered.
  $('marketplace').addEventListener('change', refreshSingleDestinations);
  $('asin').addEventListener('input', () => {
    syncDetectedMarketplace();
    refreshSingleDestinations();
  });
  refreshSingleDestinations();

  $('destination').addEventListener('change', () => {
    state.destination = state.destinations.find((d) => d.id === $('destination').value) ?? null;
    updateDestinationHint();
  });

  $('go').addEventListener('click', () => analyse());
  $('asin').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') analyse();
  });

  $('searchGo').addEventListener('click', search);
  $('searchQuery').addEventListener('keydown', (event) => {
    if (event.key === 'Enter') search();
  });

  $('sort').addEventListener('change', (event) => {
    state.sort = event.target.value;
    renderOffers();
  });

  $('exportCsv').addEventListener('click', () => exportOffers('csv'));
  $('exportXlsx').addEventListener('click', exportExcel);
}

/** Read the marketplace implied by a full Amazon URL in the input field. */
function detectedMarketplaceOf(value) {
  const match = /https?:\/\/([^\s/]+)/i.exec(value ?? '');
  if (!match) return null;
  const host = match[1].toLowerCase().replace(/\.$/, '');
  const found = state.marketplaces.find((mp) => (mp.hosts ?? []).includes(host));
  return found ? found.id : null;
}

/**
 * Keep the dropdown in step with a pasted URL.
 *
 * The URL is authoritative, so the selector jumps to match and the user is told
 * it happened rather than the two silently disagreeing.
 */
function syncDetectedMarketplace() {
  const detected = detectedMarketplaceOf($('asin').value);
  const notice = $('detectedMarketplace');
  if (!detected) {
    notice.hidden = true;
    return;
  }
  const mp = state.marketplaces.find((entry) => entry.id === detected);
  notice.hidden = false;
  notice.innerHTML = `Marketplace detected from the URL: <strong>${escapeHtml(mp?.label ?? detected)}</strong> (${escapeHtml(mp?.domain ?? '')}). The selector has been updated.`;
  if ($('marketplace').value !== detected) {
    $('marketplace').value = detected;
    state.marketplace = detected;
  }
}

/**
 * Repopulate the single-ASIN destination dropdown for the chosen marketplace.
 *
 * A marketplace with no configured destination shows an empty, disabled list
 * rather than borrowing another country's city.
 */
function refreshSingleDestinations() {
  const marketplace = state.marketplaces.find((entry) => entry.id === $('marketplace').value);
  if (!marketplace || state.destinations.length === 0) return;

  const valid = state.destinations.filter((entry) => entry.countryCode === marketplace.countryCode);
  $('destination').innerHTML = valid.length
    ? valid
        .map(
          (d) =>
            `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}${d.verified ? '' : ' (unverified)'}</option>`,
        )
        .join('')
    : '<option value="">(Amazon default — none configured)</option>';

  $('destination').disabled = valid.length === 0;
  if (valid.length > 0) {
    const preferred = valid.find((d) => d.verified) ?? valid[0];
    $('destination').value = preferred.id;
    state.destination = preferred;
  } else {
    $('destination').value = '';
    state.destination = null;
  }
  updateDestinationHint();
}

function updateDestinationHint() {
  const destination = state.destination;
  if (!destination) {
    $('destinationHint').textContent = 'No destination selected; Amazon will show its default estimate.';
    return;
  }
  $('destinationHint').textContent = destination.verified
    ? `Delivery estimates below are the ones Amazon displayed for ${destination.label}${destination.postalCode ? ` (postal code ${destination.postalCode})` : ''}.`
    : `${destination.label} is not yet verified against Amazon's location selector. Amazon may have served its default destination instead — treat these dates with caution.`;
}

// ── analysis ───────────────────────────────────────────────

async function analyse() {
  const input = $('asin').value.trim();
  if (!input) {
    banner('warn', 'Enter an ASIN or product URL first.');
    return;
  }

  // A full URL names its own marketplace; send it through and let the server
  // resolve it, so the URL always wins over the dropdown.
  const detected = detectedMarketplaceOf(input);
  const marketplace = detected ?? $('marketplace').value;

  clearBanner();
  busy($('go'), true, 'Scraping…');

  try {
    const params = new URLSearchParams({ asin: input, marketplace });
    if (state.destination?.id) params.set('destination', state.destination.id);

    const response = await fetch(`/api/product?${params}`);
    const body = await response.json();

    if (!response.ok) {
      banner('error', body.error ?? 'Scrape failed', body.hint ?? '');
      return;
    }

    state.product = body.data;

    if (body.detectedFromUrl) {
      const mp = body.marketplace;
      banner('info', `Marketplace detected from the URL: ${mp.label} (${mp.domain}).`);
    }
    if (body.staleReason) {
      banner('warn', 'Showing cached data — live scrape failed.', body.staleReason);
    } else if (body.fromCache) {
      banner('info', `Cached result, ${body.cacheAgeSeconds}s old.`, 'Re-run after the cache window expires for fresh data.');
    }
    if (!state.product.offersComplete && state.product.offersCompletenessNote) {
      banner(
        state.product.offers.length ? 'info' : 'warn',
        'Seller list may be incomplete.',
        state.product.offersCompletenessNote,
      );
    }

    renderProduct();
    renderOffers();
  } catch (error) {
    banner('error', 'Request failed', error.message);
  } finally {
    busy($('go'), false);
  }
}

function renderProduct() {
  const product = state.product;
  $('productPanel').classList.remove('hidden');

  $('productImage').src = product.image ?? '';
  $('productImage').style.display = product.image ? '' : 'none';
  $('productTitle').textContent = product.title;
  $('productBrand').textContent = product.brand ?? NA;
  $('productAsin').textContent = `ASIN ${product.asin}`;
  $('productRating').textContent = product.rating
    ? `${product.rating}${product.reviewCount ? ` (${product.reviewCount})` : ''}`
    : NA;
  $('productLink').href = product.url;

  const destination = product.destination;
  $('productDestination').textContent = destination
    ? `Delivery estimates shown for: ${destination.label}${destination.postalCode ? ` · ${destination.postalCode}` : ''}${destination.verified ? '' : ' (unverified destination)'}`
    : 'Delivery estimates: Amazon default destination';

  // Name the marketplace explicitly so results are never ambiguous.
  const mp = state.marketplaces.find((entry) => entry.id === product.marketplaceId);
  $('productMarketplace').innerHTML =
    `Marketplace: <strong>${escapeHtml(mp?.label ?? product.domain)}</strong> ` +
    `<span class="mp-tag">${escapeHtml(product.domain)}</span> ` +
    `· currency ${escapeHtml(product.currency ?? 'N/A')}` +
    (product.provenance?.detectionStatus && product.provenance.detectionStatus !== 'PROVIDED'
      ? ` · <span class="det-${product.provenance.detectionStatus === 'CONFIRMED_FOUND' ? 'confirmed' : 'unknown'}">${escapeHtml(product.provenance.detectionStatus)}</span>`
      : '');

  // Summary stats.
  const offers = product.offers;
  const priced = offers.filter((o) => o.totalPrice !== null);
  const cheapest = priced.length ? priced.reduce((a, b) => (a.totalPrice <= b.totalPrice ? a : b)) : null;
  const fastest = offers.filter((o) => o.delivery?.estimatedDays != null)
    .sort((a, b) => a.delivery.estimatedDays - b.delivery.estimatedDays)[0] ?? null;
  const buyBox = offers.find((o) => o.isBuyBox) ?? null;

  $('stats').innerHTML = [
    ['Offers found', String(offers.length)],
    ['Cheapest total', cheapest ? money(cheapest.totalPrice, product.currency) : NA, 'accent'],
    ['Cheapest seller', cheapest ? cheapest.sellerName ?? NA : NA],
    ['Fastest delivery', fastest ? `${fastest.delivery.estimatedDays} day(s)` : NA, 'accent'],
    ['Fastest seller', fastest ? fastest.sellerName ?? NA : NA],
    ['Buy Box', buyBox ? `${buyBox.sellerName ?? NA} · ${money(buyBox.totalPrice, product.currency) ?? NA}` : NA, 'warn'],
  ]
    .map(
      ([label, value, tone]) =>
        `<div class="stat ${tone ?? ''}"><div class="label">${escapeHtml(label)}</div><div class="value">${escapeHtml(String(value))}</div></div>`,
    )
    .join('');
}

// ── offers table ───────────────────────────────────────────

/** Sort a copy of the offers; never mutates the stored snapshot. */
function sortedOffers() {
  const offers = [...state.product.offers];
  const byTotal = (a, b) =>
    (a.totalPrice ?? Infinity) - (b.totalPrice ?? Infinity);
  const byDelivery = (a, b) =>
    (a.delivery?.estimatedDays ?? Infinity) - (b.delivery?.estimatedDays ?? Infinity);
  const byRating = (a, b) => (b.rating ?? -1) - (a.rating ?? -1);

  if (state.sort === 'total') return offers.sort(byTotal);
  if (state.sort === 'delivery') return offers.sort(byDelivery);
  if (state.sort === 'rating') return offers.sort(byRating);
  return offers;
}

function renderOffers() {
  const product = state.product;
  if (!product) return;

  $('offersPanel').classList.remove('hidden');

  const offers = sortedOffers();
  $('offerCount').textContent = `(${offers.length} read${
    product.offersTotalCount ? ` of ${product.offersTotalCount} advertised` : ''
  })`;

  const priced = offers.filter((o) => o.totalPrice !== null);
  const cheapestId = priced.length
    ? priced.reduce((a, b) => (a.totalPrice <= b.totalPrice ? a : b)).id
    : null;

  $('offersBody').innerHTML = offers
    .map((offer) => {
      const classes = [
        offer.isBuyBox ? 'buybox' : '',
        offer.id === cheapestId ? 'cheapest' : '',
      ].filter(Boolean).join(' ');

      const fulfilment = offer.fulfillment.toLowerCase();
      const delivery = offer.delivery;

      return `<tr class="${classes}">
        <td>
          <div class="seller">
            <span class="seller-name">${show(offer.sellerName)}</span>
            <span class="seller-sub">${offer.sellerId ?? NA}${
              offer.feedbackCount !== null ? ` · ${offer.feedbackCount.toLocaleString()} ratings` : ''
            }${offer.positiveFeedbackPercent !== null ? ` · ${offer.positiveFeedbackPercent}% positive` : ''}</span>
          </div>
        </td>
        <td class="num">${show(money(offer.price, offer.currency))}</td>
        <td class="num">${
          offer.shippingFee === null
            ? `<span class="na">${NA}</span>`
            : offer.shippingFee === 0
              ? '<span class="na">Free</span>'
              : escapeHtml(money(offer.shippingFee, offer.currency) ?? '')
        }</td>
        <td class="num total-cell">${show(money(offer.totalPrice, offer.currency))}</td>
        <td>${show(delivery?.estimatedDate ?? null)}</td>
        <td class="num">${show(delivery?.estimatedDays ?? null, (d) => `${d}d`)}</td>
        <td><span class="badge ${fulfilment}">${offer.fulfillment}</span></td>
        <td class="num">${show(offer.rating, (r) => `${r} ★`)}</td>
        <td>${
          offer.isBuyBox
            ? '<span class="badge buybox">Buy Box</span>'
            : '<span class="na">—</span>'
        }</td>
      </tr>`;
    })
    .join('');

  // Per-seller delivery text and the exact destination it applies to.
  const rows = offers
    .filter((o) => o.delivery?.originalText)
    .map(
      (o) =>
        `<li><strong>${escapeHtml(o.sellerName ?? o.id)}</strong>: ${escapeHtml(
          o.delivery.originalText,
        )} — destination: ${escapeHtml(o.delivery.destination ?? 'Amazon default')}</li>`,
    )
    .join('');

  // When Amazon never named a Buy Box winner, say so rather than leaving the
  // column silently blank — a missing badge must not read as "no winner".
  const noBuyBox =
    offers.length > 0 && !offers.some((o) => o.isBuyBox)
      ? '<br><strong>Buy Box:</strong> Amazon did not identify a Buy Box seller on the pages read for this ASIN, so none is flagged. This is reported as unknown rather than guessed.<br>'
      : '';

  $('completenessNote').innerHTML =
    (product.offersCompletenessNote ? `${escapeHtml(product.offersCompletenessNote)} ` : '') +
    noBuyBox +
    (rows ? `<br><strong>Original delivery text per seller:</strong><ul>${rows}</ul>` : '') +
    `<br><small>Scraped ${escapeHtml(new Date(product.scrapedAt).toLocaleString())}</small>`;
}

// ── search ─────────────────────────────────────────────────

async function search() {
  const query = $('searchQuery').value.trim();
  if (!query) return;

  clearBanner();
  busy($('searchGo'), true, '…');
  $('searchResults').innerHTML = '';

  try {
    const { results } = await (
      await fetch(`/api/search?q=${encodeURIComponent(query)}&marketplace=${$('marketplace').value}`)
    ).json();
    $('searchResults').innerHTML = results
      .map(
        (item) => `<button class="card" data-asin="${escapeHtml(item.asin)}">
          <img src="${escapeHtml(item.image ?? '')}" alt="" />
          <div class="t">${escapeHtml(item.title)}</div>
          <div class="p">${escapeHtml(item.price ?? NA)}</div>
        </button>`,
      )
      .join('');

    $('searchResults')
      .querySelectorAll('.card')
      .forEach((card) =>
        card.addEventListener('click', () => {
          $('asin').value = card.dataset.asin;
          analyse();
          window.scrollTo({ top: 0, behavior: 'smooth' });
        }),
      );
  } catch (error) {
    banner('error', 'Search failed', error.message);
  } finally {
    busy($('searchGo'), false);
  }
}

// ── export ─────────────────────────────────────────────────

function exportOffers(format) {
  const product = state.product;
  if (!product) return;
  const params = new URLSearchParams({ asin: product.asin });
  if (state.destination?.id) params.set('destination', state.destination.id);
  window.location.href = `/api/export?${params}`;
  void format;
}

/**
 * Excel export without a third-party library: the SpreadsheetML 2003 format is a
 * plain XML file Excel opens natively, so this stays dependency-free.
 */
function exportExcel() {
  const product = state.product;
  if (!product) return;

  const escapeXml = (value) =>
    String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[c]);

  const header = ['Seller', 'Seller ID', 'Price', 'Shipping', 'Total', 'Currency', 'Fulfilment', 'Rating', 'Feedback', 'Condition', 'Delivery date', 'Delivery days', 'Destination', 'Buy Box'];

  const rows = product.offers.map((offer) => [
    offer.sellerName, offer.sellerId, offer.price, offer.shippingFee, offer.totalPrice,
    offer.currency, offer.fulfillment, offer.rating, offer.feedbackCount, offer.condition,
    offer.delivery?.estimatedDate, offer.delivery?.estimatedDays,
    offer.delivery?.destination, offer.isBuyBox ? 'YES' : 'NO',
  ]);

  const xml = `<?xml version="1.0"?>
<Workbook xmlns="urn:schemas-microsoft-com:office:spreadsheet"
 xmlns:o="urn:schemas-microsoft-com:office:office"
 xmlns:x="urn:schemas-microsoft-com:office:excel">
 <Worksheet ss:Name="Scraper Tool ${escapeXml(product.asin)}"><Table>
  <Row>${header.map((h) => `<Cell><Data ss:Type="String">${escapeXml(h)}</Data></Cell>`).join('')}</Row>
  ${rows.map((row) => `<Row>${row.map((cell) => `<Cell><Data ss:Type="Number">${cell === null || cell === '' ? '' : escapeXml(cell)}</Data></Cell>`).join('')}</Row>`).join('')}
 </Table></Worksheet>
</Workbook>`;

  const blob = new Blob([xml], { type: 'application/vnd.ms-excel' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = `sellerctrl-${product.asin}.xls`;
  link.click();
  URL.revokeObjectURL(link.href);
}

// `init()` is async — it fetches /api/destinations before populating the
// single-ASIN selector. `initBulk()` must wait for it, otherwise the bulk
// destination dropdown renders empty because `state.destinations` is still [].
init().then(initBulk);

// ══════════════════════════════════════════════════════════════════
//  Bulk ASIN Scraper
//  Server owns the queue; this file only drives it and renders state
//  read back from the API. Closing the tab does not stop a batch.
// ══════════════════════════════════════════════════════════════════

/**
 * Multi-Region Direct Upload state.
 *
 * `enabled` is per marketplace, and each enabled marketplace owns exactly one
 * file. The upload slot is the authoritative marketplace source — nothing here
 * ever inspects an ASIN, a Region cell or a filename to decide a marketplace.
 */
const direct = {
  // Every marketplace starts ENABLED, so all six upload slots are immediately
  // usable.
  //
  // Previously only amazon.eg was enabled, which meant the other five rendered
  // as inert rows labelled "Enable to upload a file for this marketplace". A user
  // uploading EG + AE had to discover and tick a checkbox for AE first, and the
  // panel read as though all six files were required. Any subset is valid, so
  // every slot should look available and optional.
  enabled: new Set(),
  files: new Map(), // marketplaceId -> File
  // Per-slot preview results from /api/queue/preview: ASIN counts and validity
  // for the files actually attached, so Start can be enabled on real
  // information rather than on "a file was picked".
  preview: new Map(),
};

const bulk = {
  jobId: null,
  mode: 'direct-upload',
  needsDetection: 0,
  rows: [],
  results: [],
  page: 1,
  pageSize: 50,
  timer: null,
};

const $b = (id) => document.getElementById(id);
const NA2 = 'N/A';

/** Switch between the existing single-ASIN tab and the new bulk tab. */
function initTabs() {
  document.querySelectorAll('.tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach((t) => t.classList.remove('active'));
      tab.classList.add('active');
      $('tab-single').classList.toggle('hidden', tab.dataset.tab !== 'single');
      $('tab-bulk').classList.toggle('hidden', tab.dataset.tab !== 'bulk');
      if (tab.dataset.tab === 'bulk' && bulk.jobId) pollProgress();
    });
  });
}

async function initBulk() {
  initTabs();

  // Marketplace selectors, shared by the single-marketplace mode and the
  // detection checklist.
  const options = state.marketplaces
    .map((mp) => `<option value="${escapeHtml(mp.id)}">${escapeHtml(mp.label)} — ${escapeHtml(mp.domain)}</option>`)
    .join('');
  $b('bulkMarketplace').innerHTML = options;
  $b('bulkMarketplace').value = state.marketplace;
  // Changing the marketplace must repopulate the destination list, or a Cairo
  // choice made under amazon.eg would silently persist for amazon.ae.
  $b('bulkMarketplace').addEventListener('change', () => {
    if (currentMode() === 'single-marketplace') refreshBulkDestinations();
  });

  $b('detectChecks').innerHTML = state.marketplaces
    .map(
      (mp) =>
        `<label><input type="checkbox" value="${escapeHtml(mp.id)}" checked /> ${escapeHtml(mp.label)}</label>`,
    )
    .join('');

  // All six slots usable from the start; ANY subset of them is a valid job.
  // Without this only amazon.eg had a file input, and the other five rendered
  // as inert rows — which made the panel read as though all six files were
  // required and left a user uploading EG + AE unable to attach AE at all.
  for (const mp of state.marketplaces) direct.enabled.add(mp.id);

  buildDirectRows();
  // Called on init because the Start button's enabled state is derived here.
  // Without it the button is clickable with zero files attached, and the user
  // learns that from an "Empty upload" error instead of a disabled control.
  updateDirectSummary();
  $b('directStart').addEventListener('click', startDirectUpload);

  $b('bulkFilterMarket').innerHTML =
    '<option value="">All</option>' +
    state.marketplaces
      .map((mp) => `<option value="${escapeHtml(mp.id)}">${escapeHtml(mp.label)}</option>`)
      .join('');

  // Same destination list the single-ASIN view uses.

  // Switching modes reveals only the controls that apply to it.
  document.querySelectorAll('input[name="bulkMode"]').forEach((radio) =>
    radio.addEventListener('change', applyMode),
  );
  applyMode();

  $b('bulkUpload').addEventListener('click', uploadWorkbook);
  $b('bulkColumnConfirm').addEventListener('click', () => uploadWorkbook(true));
  $b('bulkPasteGo').addEventListener('click', queuePasted);
  $b('bulkStart').addEventListener('click', () => control('start'));
  $b('bulkDetect').addEventListener('click', runDetection);
  $b('bulkPause').addEventListener('click', () => control('pause'));
  $b('bulkResume').addEventListener('click', () => control('resume'));
  $b('bulkCancel').addEventListener('click', () => control('cancel'));
  $b('bulkRetry').addEventListener('click', () => control('retry'));

  $b('bulkDiagnostics').addEventListener('click', () => {
    if (!bulk.jobId) return;
    // Separate, optional report of checks that produced no product. It is
    // never merged into the seller-results workbook.
    window.location.href = `/api/bulk/jobs/${bulk.jobId}/diagnostics.tsv`;
  });
  $b('bulkXlsx').addEventListener('click', () => downloadExport('xlsx'));
  $b('bulkTsv').addEventListener('click', () => downloadExport('tsv'));
  $b('bulkCopy').addEventListener('click', copyAllResults);

  $b('bulkFilter').addEventListener('input', () => { bulk.page = 1; renderBulkResults(); });
  for (const id of ['bulkFilterMarket', 'bulkFilterDetection', 'bulkFilterFul', 'bulkFilterBuybox', 'bulkSort']) {
    $b(id).addEventListener('change', () => { bulk.page = 1; renderBulkResults(); });
  }
  $b('bulkPrev').addEventListener('click', () => { bulk.page = Math.max(1, bulk.page - 1); renderBulkResults(); });
  $b('bulkNext').addEventListener('click', () => { bulk.page += 1; renderBulkResults(); });

  await reattachBulkJob();
}

/**
 * Reattach to the most recent unfinished job after a reload.
 *
 * Progress lives in SQLite, so reattaching simply re-reads it — the counters are
 * not reconstructed client-side and cannot drift from the server's view.
 */
async function reattachBulkJob() {
  let stored = null;
  try { stored = localStorage.getItem('scraperTool.bulkJob'); } catch { stored = null; }

  try {
    const { jobs } = await (await fetch('/api/bulk/jobs')).json();
    if (!Array.isArray(jobs) || jobs.length === 0) return;

    // Prefer the job this tab was last driving. Failing that, adopt the most
    // recent one that is still unfinished — that is what makes reopening the
    // browser resume a live batch rather than showing an empty dashboard.
    const unfinished = (job) => job.status === 'running' || job.status === 'paused' || job.status === 'queued';
    const match =
      (stored ? jobs.find((job) => job.id === stored) : undefined) ??
      jobs.find(unfinished);
    if (!match) return;
    if (stored && match.id !== stored) {
      try { localStorage.setItem('scraperTool.bulkJob', match.id); } catch { /* ignore */ }
    }

    bulk.jobId = match.id;
    bulk.mode = match.mode;
    $b('bulkProgressPanel').classList.remove('hidden');
    pollProgress();
    // Repopulate the results table so a reattached tab is fully usable.
    loadBulkResults();
    banner(
      'info',
      `Reattached to batch ${match.id.slice(0, 8)} (${match.status}).`,
      'Progress is read from the server, so it reflects everything that happened while this tab was closed.',
    );
  } catch {
    // A failed reattach must never block the rest of the UI.
  }
}

/**
 * Render one row per marketplace: an enable toggle plus, when enabled, a
 * dedicated file input.
 *
 * Each file input posts under its marketplace id as the multipart field name,
 * which is how the server learns which Amazon site a file belongs to.
 */
function buildDirectRows() {
  $b('directRows').innerHTML = state.marketplaces
    .map(
      (mp) => `
      <div class="direct-row" id="dr-${escapeHtml(mp.id)}">
        <label class="dr-name">
          <input type="checkbox" class="dr-toggle" data-mp="${escapeHtml(mp.id)}"
                 ${direct.enabled.has(mp.id) ? 'checked' : ''} />
          ${escapeHtml(mp.label)}
        </label>
        <span class="dr-domain">${escapeHtml(mp.domain)}</span>
        ${
          direct.enabled.has(mp.id)
            ? `<span class="dr-file">
                 <input type="file" accept=".xlsx" class="dr-file-input" data-mp="${escapeHtml(mp.id)}" />
                 <button type="button" class="dr-clear" data-mp="${escapeHtml(mp.id)}">Remove</button>
               </span>
               <span class="dr-count" id="drc-${escapeHtml(mp.id)}"></span>`
            : '<span class="dr-file dr-off">Enable to upload a file for this marketplace</span>'
        }
      </div>`,
    )
    .join('');

  $b('directRows')
    .querySelectorAll('.dr-toggle')
    .forEach((box) =>
      box.addEventListener('change', () => {
        const id = box.dataset.mp;
        if (box.checked) direct.enabled.add(id);
        else {
          direct.enabled.delete(id);
          direct.files.delete(id);
        }
        buildDirectRows();
        updateDirectSummary();
      }),
    );

  $b('directRows')
    .querySelectorAll('.dr-file-input')
    .forEach((input) =>
      input.addEventListener('change', () => {
        const id = input.dataset.mp;
        const file = input.files && input.files[0];
        if (file) {
          direct.files.set(id, file);
          $(`drc-${id}`).textContent = `${file.name}`;
        } else {
          direct.files.delete(id);
          $(`drc-${id}`).textContent = '';
        }
        // Picking another file for the same slot replaces it, so a mistaken
        // pick is recoverable without clearing the whole job.
        direct.preview.delete(id);
        updateDirectSummary();
        refreshDirectPreview();
      }),
    );

  $b('directRows')
    .querySelectorAll('.dr-clear')
    .forEach((button) =>
      button.addEventListener('click', () => {
        const id = button.dataset.mp;
        direct.files.delete(id);
        direct.preview.delete(id);
        buildDirectRows();
        updateDirectSummary();
        refreshDirectPreview();
      }),
    );
}

/**
 * Live summary of the Direct Upload panel.
 *
 * Counts what will actually be scraped, not what is merely enabled. Start is
 * enabled when at least one file is attached and readable — a single file is a
 * complete job, so an empty slot is never a reason to block.
 *
 * While the server preview is still in flight the button stays disabled, so the
 * user cannot start a job whose files have not been validated yet.
 */
function updateDirectSummary() {
  const attached = direct.files.size;
  const slots = [...direct.preview.values()];
  const valid = slots.filter((s) => s.valid).length;
  const invalid = slots.filter((s) => !s.valid && s.error).length;
  const previewing = direct.preview.size < attached;

  if (attached === 0) {
    $b('directSummary').textContent =
      `Any combination of marketplaces is accepted — attach a file to one or more of the ` +
      `${direct.enabled.size} slots. Unused slots are ignored.`;
  } else if (previewing) {
    $b('directSummary').textContent = `${attached} file(s) attached — checking…`;
  } else {
    const asins = slots.reduce((sum, s) => sum + (s.uniqueAsins || 0), 0);
    const parts = [
      `${attached} marketplace(s) selected`,
      `${asins.toLocaleString()} unique ASIN(s)`,
      invalid ? `${invalid} unreadable file(s)` : null,
      valid >= attached ? 'ready to start' : 'fix the highlighted file(s)',
    ].filter(Boolean);
    $b('directSummary').textContent = parts.join(' · ');
  }

  // Disabled with nothing attached, while validating, or when every attached
  // file failed to read.
  $b('directStart').disabled = attached === 0 || previewing || valid === 0;
}

/**
 * Ask the server to validate and count the attached workbooks.
 *
 * Parsing happens server-side because the browser has no Excel reader and
 * because the count must come from the same parser the job will use — a
 * client-side estimate could disagree with what actually gets scraped.
 *
 * Debounced so choosing files one at a time sends one request, not one per
 * click.
 */
let directPreviewTimer = null;
function refreshDirectPreview() {
  if (directPreviewTimer) clearTimeout(directPreviewTimer);
  if (direct.files.size === 0) {
    direct.preview.clear();
    updateDirectSummary();
    return;
  }

  directPreviewTimer = setTimeout(async () => {
    const form = new FormData();
    for (const [marketplaceId, file] of direct.files) form.append(marketplaceId, file);

    let result = null;
    try {
      const response = await fetch('/api/queue/preview', { method: 'POST', body: form });
      result = await response.json();
    } catch {
      result = null;
    }

    direct.preview.clear();
    if (result && Array.isArray(result.slots)) {
      for (const slot of result.slots) direct.preview.set(slot.marketplaceId, slot);
    }
    renderDirectPreview();
    updateDirectSummary();
  }, 250);
}

/** Paint per-slot state: ready, invalid, or awaiting a column choice. */
function renderDirectPreview() {
  for (const [id, slot] of direct.preview) {
    const countEl = $(`drc-${id}`);
    if (!countEl) continue;

    const row = document.getElementById(`dr-${id}`);
    if (row) row.classList.remove('dr-invalid', 'dr-ready', 'dr-needs-column');

    if (slot.error) {
      countEl.textContent = `${slot.filename}: ${slot.error}`;
      countEl.title = slot.error;
      row?.classList.add('dr-invalid');
    } else if (slot.needsColumn) {
      countEl.textContent = `${slot.filename}: choose the ASIN column`;
      countEl.title = 'The ASIN column could not be identified.';
      row?.classList.add('dr-needs-column');
    } else if (slot.valid) {
      const dupes = slot.duplicates ? `, ${slot.duplicates} duplicate` : '';
      const bad = slot.invalid ? `, ${slot.invalid} invalid` : '';
      countEl.textContent = `${slot.filename}: ${slot.uniqueAsins} ASIN(s)${dupes}${bad}`;
      countEl.title = `${slot.rows} row(s), ${slot.uniqueAsins} unique`;
      row?.classList.add('dr-ready');
    } else {
      countEl.textContent = `${slot.filename}: no usable ASINs`;
      row?.classList.add('dr-invalid');
    }
  }
}

/**
 * Upload every attached file in one request and queue the combined job.
 *
 * The FormData field name is the marketplace id, so the server assigns the
 * marketplace from the slot alone.
 */
async function startDirectUpload() {
  if (direct.files.size === 0) {
    banner('warn', 'Attach at least one Excel file first.');
    return;
  }

  const form = new FormData();
  for (const [marketplaceId, file] of direct.files) form.append(marketplaceId, file);

  const params = new URLSearchParams();
  const destination = $b('bulkDestination');
  if (destination && destination.value) params.set('destination', destination.value);

  clearBanner();

  // Background mode hands the job to the durable worker queue instead of
  // scraping inside this page. The difference matters: a queued job keeps going
  // after this tab is closed and after the server restarts, and it appears in
  // History with its reports archived. The in-process path below stays available
  // for one-off jobs where that is not wanted.
  if ($b('directBackground')?.checked) {
    return queueDirectUpload(form, params);
  }

  busy($b('directStart'), true, 'Queuing…');

  try {
    const response = await fetch(`/api/bulk/direct?${params}`, { method: 'POST', body: form });
    const body = await response.json();

    if (!response.ok) {
      banner('error', body.error ?? 'Upload failed', '');
      return;
    }

    if (body.needsColumn) {
      const first = body.marketplaces?.[0];
      banner(
        'warn',
        'The ASIN column could not be recognised.',
        `${first?.files?.join(', ') ?? 'A file'} — headers: ${(first?.headers ?? []).join(', ') || '(none)'}`,
      );
      return;
    }

    bulk.jobId = body.jobId;
    bulk.mode = 'direct-upload';
    $b('bulkQueuePanel').classList.remove('hidden');
    $b('bulkProgressPanel').classList.remove('hidden');

    const perMarket = (body.marketplaces ?? [])
      .map((m) => `${m.marketplaceDomain}: ${m.rows} ASINs`)
      .join(' · ');
    $b('bulkImportStats').innerHTML =
      statHtml('Input ASIN rows', body.inputRows) +
      statHtml('Unique records', body.uniqueRecords) +
      statHtml('Duplicate rows', body.duplicateInputRows) +
      statHtml('Blank rows ignored', body.blankRowsIgnored) +
      statHtml('Invalid values', body.invalidCount) +
      statHtml('Detection requests', 0);

    $b('bulkWorkload').innerHTML =
      `Direct Upload — <strong>zero</strong> marketplace detection requests. ` +
      `Each ASIN goes straight to its own marketplace product page.<br>${escapeHtml(perMarket)}`;
    $b('bulkInvalid').classList.add('hidden');

    banner(
      'info',
      `${body.uniqueRecords} product-marketplace record(s) queued across ${body.marketplaces.length} marketplace(s).`,
      'Nothing has been scraped yet — press Start to begin.',
    );

    try { localStorage.setItem('scraperTool.bulkJob', body.jobId); } catch { /* ignore */ }
    $b('bulkStart').classList.remove('hidden');
    $b('bulkDetect').classList.add('hidden');
    pollProgress();
  } catch (error) {
    banner('error', 'Upload failed', error.message);
  } finally {
    busy($b('directStart'), false);
  }
}

/**
 * Submit a Direct Upload to the durable queue.
 *
 * Nothing is scraped here: the job is written to the database and the worker
 * picks it up. That is what makes it safe to close the tab.
 */
async function queueDirectUpload(form, params) {
  busy($b('directStart'), true, 'Queuing…');
  try {
    const response = await fetch(`/api/queue/direct?${params}`, { method: 'POST', body: form });
    const body = await response.json();

    if (!response.ok) {
      banner('error', body.error ?? 'Upload failed', '');
      return;
    }
    if (body.needsColumn) {
      const first = body.marketplaces?.[0];
      banner(
        'warn',
        'The ASIN column could not be recognised.',
        `${first?.files?.join(', ') ?? 'A file'} — headers: ${(first?.headers ?? []).join(', ') || '(none)'}`,
      );
      return;
    }

    $b('bulkQueuePanel').classList.remove('hidden');
    $b('bulkProgressPanel').classList.remove('hidden');
    $b('bulkImportStats').innerHTML =
      statHtml('Input ASIN rows', body.inputRows) +
      statHtml('Unique ASINs', body.uniqueAsins) +
      statHtml('Duplicate rows', body.duplicates) +
      statHtml('Blank rows ignored', body.blank) +
      statHtml('Invalid values', body.invalid);

    $b('bulkWorkload').innerHTML =
      `Direct Upload — <strong>zero</strong> marketplace detection requests. ` +
      `Each ASIN goes straight to its own marketplace product page.<br>` +
      `${escapeHtml((body.marketplaces ?? []).join(', '))}`;

    banner('info', `${body.queued} product-marketplace record(s) queued.`, body.message ?? '');

    try { localStorage.setItem('scraperTool.queueJob', body.jobId); } catch { /* ignore */ }
    pollQueueProgress(body.jobId);
  } catch (error) {
    banner('error', 'Upload failed', error.message);
  } finally {
    busy($b('directStart'), false);
  }
}

/**
 * Poll a queued job.
 *
 * Polling stops once the job reaches a terminal state, so an idle page does not
 * keep talking to the server forever. The job itself is unaffected by this: it
 * is running in the worker regardless of whether anything is watching.
 */
async function pollQueueProgress(jobId) {
  if (!jobId) return;
  $b('bulkProgressPanel').classList.remove('hidden');

  for (;;) {
    let detail = null;
    try {
      detail = await (await fetch(`/api/queue/jobs/${jobId}`)).json();
    } catch {
      // A transient network error must not abandon the display; the next tick
      // picks it up again.
      await new Promise((r) => setTimeout(r, 5000));
      continue;
    }
    if (!detail || !detail.job) break;

    const job = detail.job;
    const total = job.uniqueAsins || 1;
    const done = job.successfulRecords || 0;
    const percent = Math.min(100, Math.round(((done + job.failedRecords) / total) * 100));

    $b('bulkBar').style.width = `${percent}%`;
    $b('bulkPercent').textContent = `${percent}%`;
    $b('bulkImportStats').innerHTML =
      statHtml('Status', job.status) +
      statHtml('ASINs', total) +
      statHtml('Completed', done) +
      statHtml('Failed', job.failedRecords) +
      statHtml('Not found', job.notFoundRecords) +
      statHtml('Seller offers', job.totalSellerOffers) +
      statHtml('Reports', job.reportCount);

    if (['COMPLETED', 'FAILED', 'CANCELLED'].includes(job.status)) {
      $b('bulkWorkload').innerHTML =
        `Job <strong>${job.status}</strong>. ` +
        `${job.totalSellerOffers} seller offer(s) across ${done} product(s). ` +
        'Reports are archived and downloadable from the History page.';
      banner(
        job.status === 'COMPLETED' ? 'info' : 'warn',
        `Job ${job.status.toLowerCase()}.`,
        'Open History to download the Excel and TSV reports.',
      );
      break;
    }
    await new Promise((r) => setTimeout(r, 3000));
  }
}

/**
 * Load the dashboard counters.
 *
 * Nothing here is computed or estimated: each tile is a value the database
 * reported. A failed request leaves the em dashes in place rather than showing
 * zeros, so a broken endpoint is never mistaken for "nothing has been scraped".
 */
async function loadDashboard() {
  const set = (id, value) => {
    const el = $(id);
    if (el) el.textContent = value;
  };
  try {
    const res = await fetch('/api/stats');
    if (!res.ok) return;
    const s = await res.json();
    const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v.toLocaleString() : '—');

    set('dash-total', num(s.totalJobs));
    set('dash-completed', num(s.completedJobs));
    set('dash-active', num(s.activeJobs));
    set('dash-asins', num(s.totalUniqueAsins));
    set('dash-offers', num(s.totalSellerOffers));
    set('dash-reports', num(s.savedReports));
    set('dash-last', s.lastScrapedAt ? String(s.lastScrapedAt).slice(0, 10) : '—');
    set('dash-disk', s.freeDiskText ?? '—');

    // Low disk is worth flagging before it silently truncates a job: a large
    // batch needs room for its snapshots and its Excel export.
    const strip = document.getElementById('dashboard');
    if (strip && typeof s.freeDiskBytes === 'number') {
      strip.classList.toggle('is-low', s.freeDiskBytes < 1024 * 1024 * 1024);
      if (s.freeDiskBytes < 1024 * 1024 * 1024 && s.freeDiskText) {
        strip.title = `Low disk space: ${s.freeDiskText} free. Free space before starting a large batch.`;
      }
    }
  } catch {
    /* leave the placeholders */
  }
}

/** One stat tile. */
function statHtml(label, value) {
  return `<div class="stat"><div class="label">${escapeHtml(String(label))}</div>` +
         `<div class="value">${escapeHtml(String(value ?? 0))}</div></div>`;
}

/** The currently selected bulk mode. */
function currentMode() {
  return document.querySelector('input[name="bulkMode"]:checked')?.value ?? 'single-marketplace';
}

/** Show only the controls that apply to the selected mode. */
function applyMode() {
  const mode = currentMode();
  const directMode = mode === 'direct-upload';
  $b('directPanel').classList.toggle('hidden', !directMode);
  $b('bulkFileField').classList.toggle('hidden', directMode);
  // Direct Upload uses its own per-marketplace file inputs.
  $b('bulkUpload').classList.toggle('hidden', directMode);

  const mixed = mode !== 'single-marketplace';
  $b('singleMarketField').classList.toggle('hidden', mode !== 'single-marketplace');
  $b('detectBox').classList.toggle('hidden', mode !== 'auto-detect');

  // A single delivery destination cannot describe five marketplaces, so the
  // mixed modes do not show one. Each marketplace is handled on its own terms.
  $b('bulkDestinationField').classList.toggle('hidden', mixed);
  $b('bulkDestinationNote').hidden = !mixed;

  // In single-marketplace mode only destinations valid for that marketplace's
  // country are offered, so Cairo can never be selected for amazon.ae.
  if (!mixed) refreshBulkDestinations();
}

/**
 * Repopulate the bulk destination dropdown for the selected marketplace.
 *
 * When a marketplace has no configured destination the dropdown is left empty
 * and disabled rather than offering another country's city — Amazon's own
 * default is used instead, and that is recorded honestly.
 */
function refreshBulkDestinations() {
  const marketplace = state.marketplaces.find((entry) => entry.id === $b('bulkMarketplace').value);
  if (!marketplace) return;

  const valid = state.destinations.filter((entry) => entry.countryCode === marketplace.countryCode);
  $b('bulkDestination').innerHTML = valid.length
    ? valid
        .map(
          (d) =>
            `<option value="${escapeHtml(d.id)}">${escapeHtml(d.label)}${d.verified ? '' : ' (unverified)'}</option>`,
        )
        .join('')
    : '<option value="">(Amazon default — none configured)</option>';

  $b('bulkDestination').disabled = valid.length === 0;
  if (valid.length > 0) {
    const preferred = valid.find((d) => d.verified) ?? valid[0];
    $b('bulkDestination').value = preferred.id;
  } else {
    $b('bulkDestination').value = '';
  }
}

/** Marketplaces ticked for automatic detection. */
function selectedDetectMarkets() {
  return Array.from($b('detectChecks').querySelectorAll('input:checked')).map((input) => input.value);
}

/** Upload the selected workbook, optionally forcing column indices. */
async function uploadWorkbook(forceColumns = false) {
  const input = $b('bulkFile');
  if (!input.files || input.files.length === 0) {
    banner('warn', 'Choose an .xlsx file first.');
    return;
  }

  const file = input.files[0];
  const form = new FormData();
  form.append('file', file);

  const mode = currentMode();
  const params = new URLSearchParams({ mode });
  // Mixed modes deliberately send no destination at all.
  if (mode === 'single-marketplace') params.set('destination', $b('bulkDestination').value);
  if (mode === 'single-marketplace') params.set('marketplace', $b('bulkMarketplace').value);
  if (mode === 'auto-detect') params.set('detectMarkets', selectedDetectMarkets().join(','));

  if (forceColumns) {
    if ($b('bulkColumn').value !== '') params.set('column', $b('bulkColumn').value);
    if ($b('bulkRegionColumn').value !== '') params.set('regionColumn', $b('bulkRegionColumn').value);
    if ($b('bulkUrlColumn').value !== '') params.set('urlColumn', $b('bulkUrlColumn').value);
  }

  clearBanner();
  busy($b('bulkUpload'), true, 'Reading…');

  try {
    const response = await fetch(`/api/bulk/upload?${params}`, { method: 'POST', body: form });
    const body = await response.json();

    if (!response.ok) {
      banner('error', body.error ?? 'Upload failed', '');
      return;
    }

    // No identifier column recognised — offer manual selection.
    if (body.needsColumn) {
      const fill = (select, headers) => {
        select.innerHTML =
          '<option value="">— none —</option>' +
          headers
            .map((header, index) => `<option value="${index}">${escapeHtml(header || `(column ${index + 1})`)}</option>`)
            .join('');
      };
      fill($b('bulkColumn'), body.headers);
      fill($b('bulkRegionColumn'), body.headers);
      fill($b('bulkUrlColumn'), body.headers);
      $b('bulkColumnPicker').classList.remove('hidden');
      banner('warn', body.message, '');
      return;
    }

    showQueue(body);
  } catch (error) {
    banner('error', 'Upload failed', error.message);
  } finally {
    busy($b('bulkUpload'), false);
  }
}

/** Queue a pasted list of ASINs or Amazon URLs. */
async function queuePasted() {
  const text = $b('bulkPaste').value.trim();
  if (!text) {
    banner('warn', 'Paste some identifiers first.');
    return;
  }

  const mode = currentMode();
  clearBanner();
  busy($b('bulkPasteGo'), true, '…');
  try {
    const params = new URLSearchParams();
    // Restrict auto-detect candidates to the marketplaces actually ticked, so
    // the job does not queue checks that will never run.
    if (mode === 'auto-detect') params.set('detectMarkets', selectedDetectMarkets().join(','));
    const response = await fetch(`/api/bulk/text?${params}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        text,
        mode,
        // Omitted in mixed modes: there is no single correct destination.
        ...(mode === 'single-marketplace' ? { destination: $b('bulkDestination').value } : {}),
        marketplace: $b('bulkMarketplace').value,
      }),
    });
    const body = await response.json();
    if (!response.ok) {
      banner('error', body.error ?? 'Could not queue those identifiers', '');
      return;
    }
    showQueue(body);
  } catch (error) {
    banner('error', 'Failed', error.message);
  } finally {
    busy($b('bulkPasteGo'), false);
  }
}

/**
 * Show the imported queue without starting anything.
 *
 * The preview deliberately distinguishes a region the user *provided* from one
 * that still has to be *verified* against Amazon.
 */
function showQueue(body) {
  bulk.jobId = body.jobId;
  // Remember the job so a reload or a reopened tab can reattach to the live
  // batch instead of showing an empty dashboard.
  try { localStorage.setItem('scraperTool.bulkJob', body.jobId); } catch { /* private mode */ }
  bulk.mode = body.mode;
  bulk.needsDetection = body.needsDetection ?? 0;
  bulk.page = 1;

  $b('bulkColumnPicker').classList.add('hidden');
  $b('bulkQueuePanel').classList.remove('hidden');

  $b('bulkImportStats').innerHTML = [
    ['Identifiers imported', body.imported],
    ['Queued items', body.queuedItems ?? body.imported],
    ['Duplicates removed', body.duplicatesRemoved ?? 0],
    ['Blank rows ignored', body.blanksIgnored ?? 0],
    ['Invalid values', body.invalidCount ?? 0],
    ['Needing detection', body.needsDetection ?? 0],
  ]
    .map(
      ([label, value]) =>
        `<div class="stat"><div class="label">${escapeHtml(String(label))}</div><div class="value">${escapeHtml(String(value ?? 0))}</div></div>`,
    )
    .join('');

  // Make the real workload visible before anything is scraped. A detection
  // sweep is one page load per (ASIN, marketplace), so it dominates the cost.
  const planned = body.plannedChecks ?? 0;
  $b('bulkWorkload').innerHTML = planned
    ? `This batch will need <strong>${planned}</strong> marketplace check(s) before scraping, ` +
      `plus up to ${body.queuedItems ?? body.imported} product scrape(s) of 2 pages each. ` +
      `At a minimum 4-second gap between requests this is a long run — start it and close this tab safely, ` +
      `the queue runs on the server.`
    : 'Scraping has not started. Press Start when ready.';

  if (body.invalidCount) {
    $b('bulkInvalid').classList.remove('hidden');
    $b('bulkInvalid').innerHTML =
      `<strong>${escapeHtml(String(body.invalidCount))} value(s) were not valid ASINs and were skipped:</strong><ul>` +
      (body.invalid ?? [])
        .map((entry) => `<li>Row ${escapeHtml(String(entry.rowNumber))}: <code>${escapeHtml(entry.value)}</code></li>`)
        .join('') +
      '</ul>';
  } else {
    $b('bulkInvalid').classList.add('hidden');
  }

  const preview = body.preview ?? [];
  $b('bulkPreviewBody').innerHTML = preview
    .map((row) => {
      const mp = state.marketplaces.find((entry) => entry.id === row.marketplaceId);
      const status = row.detectionStatus === 'NOT_CHECKED' ? 'Auto detection required' : row.detectionStatus;
      const tone =
        row.detectionStatus === 'CONFIRMED_FOUND' ? 'det-confirmed'
        : row.detectionStatus === 'PROVIDED' ? 'det-provided'
        : 'det-unknown';
      return `<tr>
        <td class="num">${escapeHtml(String(row.rowNumber))}</td>
        <td>${escapeHtml(row.asin)}</td>
        <td>${escapeHtml(row.originalInput || '—')}</td>
        <td>${mp ? `<span class="mp-tag">${escapeHtml(mp.domain)}</span>` : '<span class="na">Pending</span>'}</td>
        <td class="${tone}">${escapeHtml(status)}</td>
        <td>${escapeHtml(row.detectionMethod)}</td>
      </tr>`;
    })
    .join('');

  // Auto-detect needs its detection pass run before any scraping.
  $b('bulkStart').classList.toggle('hidden', (body.needsDetection ?? 0) > 0);
  $b('bulkDetect').classList.toggle('hidden', (body.needsDetection ?? 0) === 0);

  banner(
    'info',
    `${body.imported} identifier(s) queued. Nothing has been scraped yet.`,
    (body.needsDetection ?? 0) > 0
      ? 'Run marketplace detection first, then start the batch.'
      : 'Press "Start batch" to begin. You can close this tab — the batch keeps running on the server.',
  );
}

/** Kick off the marketplace detection pass for the queued job. */
async function runDetection() {
  if (!bulk.jobId) return;
  busy($b('bulkDetect'), true, 'Detecting…');
  try {
    const markets = selectedDetectMarkets().join(',');
    const response = await fetch(`/api/bulk/jobs/${bulk.jobId}/detect?marketplaces=${markets}`, {
      method: 'POST',
    });
    const body = await response.json();
    if (!response.ok) {
      banner('error', body.error ?? 'Detection failed', '');
      return;
    }
    $b('bulkProgressPanel').classList.remove('hidden');
    banner(
      'info',
      `Detecting ${body.plannedChecks} marketplace check(s).`,
      'Each check is a real page load. A restricted or failed check is never counted as "not found".',
    );
    pollProgress();
  } catch (error) {
    banner('error', 'Detection failed', error.message);
  } finally {
    busy($b('bulkDetect'), false);
  }
}

/** Start / pause / resume / cancel / retry. */
async function control(action) {
  if (!bulk.jobId) return;
  try {
    const response = await fetch(`/api/bulk/jobs/${bulk.jobId}/${action}`, { method: 'POST' });
    const body = await response.json();
    if (!response.ok) {
      banner('error', body.error ?? 'Action failed', '');
      return;
    }
    if (action === 'retry') {
      banner('info', `${body.requeued} failed ASIN(s) requeued.`, body.blocked ? `Amazon access is currently restricted: ${body.blockReason}` : '');
    }
    pollProgress();
  } catch (error) {
    banner('error', 'Action failed', error.message);
  }
}

/** Poll server-side progress. The batch runs regardless of this tab. */
/** Human label for a marketplace id, falling back to the raw id. */
function marketLabel(id) {
  if (!id) return 'unknown marketplace';
  return state.marketplaces.find((entry) => entry.id === id)?.label ?? id;
}

async function pollProgress() {
  if (!bulk.jobId) return;

  try {
    const progress = await (await fetch(`/api/bulk/jobs/${bulk.jobId}/progress`)).json();

    $b('bulkProgressPanel').classList.remove('hidden');
    $b('bulkBar').style.width = `${progress.percent}%`;
    $b('bulkPercent').textContent = `${progress.percent}%`;

    const stat = (label, value) =>
      `<div class="stat"><div class="label">${escapeHtml(String(label))}</div>` +
      `<div class="value">${escapeHtml(String(value))}</div></div>`;

    // ---- Multi-Region Direct Upload ----
    // Shown instead of the detection stage, which this mode never runs.
    const directMode = progress.mode === 'direct-upload';
    $b('bulkMultiRegionStage').hidden = !directMode;
    $b('bulkDetectStage').classList.toggle('hidden', directMode);

    if (directMode) {
      const markets = progress.marketplaces ?? [];
      const totals = markets.reduce(
        (acc, m) => ({
          total: acc.total + m.total,
          settled: acc.settled + m.done + m.failed + m.skipped,
          done: acc.done + m.done,
          failed: acc.failed + m.failed,
          notFound: acc.notFound + m.skipped,
          offers: acc.offers + m.offers,
        }),
        { total: 0, settled: 0, done: 0, failed: 0, notFound: 0, offers: 0 },
      );
      const remaining = Math.max(0, totals.total - totals.settled);
      const pct = totals.total > 0 ? Math.round((totals.settled / totals.total) * 1000) / 10 : 0;

      $b('bulkMultiRegionPct').textContent = `${pct}%`;
      $b('bulkMultiRegionStats').innerHTML =
        stat('Total input rows', totals.total) +
        stat('Unique records', totals.total) +
        stat('Completed', totals.done) +
        stat('Failed', totals.failed) +
        stat('Not found', totals.notFound) +
        stat('Seller offers', totals.offers) +
        stat('Remaining', remaining) +
        stat('Status', progress.status.toUpperCase());

      const active = markets.find((m) => m.state === 'active');
      $b('bulkMultiRegionNote').textContent = active
        ? `Scraping ${active.currentAsin ?? '…'} on ${active.label}. ` +
          `Only one request runs at a time, so marketplaces are processed in queue order — not in parallel.`
        : 'One request at a time under a shared rate limiter; marketplaces are worked through in queue order.';

      $b('bulkMarketList').innerHTML = markets
        .map(
          (m) => `<div class="market-row">
            <span class="mr-name">${escapeHtml(m.label)}<br><span class="dr-domain">${escapeHtml(m.domain)}</span></span>
            <span class="mr-bar"><span class="mr-fill" style="width:${Math.min(100, m.percent)}%"></span></span>
            <span class="mr-count">${escapeHtml(String(m.done))} / ${escapeHtml(String(m.total))} · ${escapeHtml(String(m.percent))}%</span>
            <span class="mr-state ${escapeHtml(m.state)}">${escapeHtml(m.state)}</span>
          </div>`,
        )
        .join('');

      // Hide the extraction/final sections; their content is folded in above.
      $b('bulkScrapeStage').classList.add('hidden');
      $b('bulkResultsStage').classList.add('hidden');
    } else {
      $b('bulkScrapeStage').classList.remove('hidden');
      $b('bulkResultsStage').classList.remove('hidden');
    }

    // ---- Stage 1: marketplace detection ----
    const d = progress.detection;
    $b('bulkDetectTitle').textContent =
      d.remainingChecks > 0
        ? 'Marketplace Detection — running'
        : d.totalChecks > 0
          ? 'Marketplace Detection — complete'
          : 'Marketplace Detection — not required';
    $b('bulkDetectPct').textContent = `${d.percent}%`;
    $b('bulkDetectStage').classList.toggle('active', d.remainingChecks > 0);
    $b('bulkDetectStats').innerHTML =
      stat('Total checks', d.totalChecks) +
      stat('Completed', d.completedChecks) +
      stat('Remaining', d.remainingChecks) +
      stat('Confirmed matches', d.confirmedMatches) +
      stat('Not found', d.notFound) +
      stat('Failed', d.failed) +
      stat('Restricted', d.restricted) +
      (d.multiMarketplaceAsins > 0 ? stat('Multi-market ASINs', d.multiMarketplaceAsins) : '');
    $b('bulkDetectCurrent').textContent = d.currentAsin
      ? `Currently checking: ${d.currentAsin} on ${marketLabel(d.currentMarketplace)}`
      : d.totalChecks > 0 && d.remainingChecks === 0
        ? `All ${d.totalChecks} check(s) settled: ${d.confirmedMatches} match(es), ${d.notFound} not found.`
        : 'No marketplace checks were required for this mode.';

    // ---- Stage 2: seller extraction ----
    const e = progress.extraction;
    $b('bulkScrapePct').textContent = `${e.percent}%`;
    $b('bulkScrapeStage').classList.toggle('active', e.remaining > 0);
    $b('bulkScrapeStats').innerHTML =
      stat('Confirmed matches', e.totalConfirmed) +
      stat('Scraped', e.scraped) +
      stat('Failed', e.failed) +
      stat('Seller offers', e.offersFound) +
      stat('Remaining', e.remaining) +
      stat('Status', progress.status.toUpperCase());

    // While detection runs, say so plainly rather than showing zeros that look
    // like a stalled job.
    const eta = $b('bulkEta');
    if (progress.phase === 'detect') {
      // Stage 1 owns the request budget; saying so beats showing zeros that
      // look like a stalled job.
      eta.textContent =
        'Detecting marketplaces — seller extraction starts once detection finishes.';
    } else if (e.currentAsin) {
      eta.textContent = `Currently scraping: ${e.currentAsin} on ${marketLabel(e.currentMarketplace)}`;
    } else if (e.totalConfirmed === 0) {
      eta.textContent = 'No confirmed marketplace matches to scrape.';
    } else {
      eta.textContent = '';
    }

    // ETA is only shown when the server considers it reliable (>=2 completed).
    if (e.estimatedSecondsRemaining !== null && e.remaining > 0) {
      const seconds = e.estimatedSecondsRemaining;
      const minutes = Math.floor(seconds / 60);
      const hours = Math.floor(minutes / 60);
      eta.textContent += ` · about ${
        hours > 0 ? `${hours}h ${minutes % 60}m` : minutes > 0 ? `${minutes} min` : `${seconds}s`
      } remaining (measured, not estimated)`;
    }

    // ---- Stage 3: final results ----
    const r = progress.results;
    $b('bulkResultsStats').innerHTML =
      stat('Product-marketplace matches', r.confirmedProductMarketplaceMatches) +
      stat('With seller offers', r.productsWithOffers) +
      stat('Exportable seller rows', r.exportableSellerRows);

    // A restriction is surfaced prominently, never reported as success.
    if (progress.pausedReason) {
      $b('bulkBlocked').classList.remove('hidden');
      $b('bulkBlocked').innerHTML = `<strong>Processing paused</strong>${escapeHtml(progress.pausedReason)}`;
    } else {
      $b('bulkBlocked').classList.add('hidden');
    }

    // Refresh the results table as data arrives.
    const items = await (await fetch(`/api/bulk/jobs/${bulk.jobId}/items`)).json();
    renderBulkItems(items.items ?? []);

    const finished = progress.status === 'completed' || progress.status === 'cancelled';
    if (bulk.timer) {
      if (finished) {
        clearInterval(bulk.timer);
        bulk.timer = null;
        loadBulkResults();
      }
    } else if (!finished) {
      bulk.timer = setInterval(pollProgress, 2000);
    }
  } catch {
    // Transient network hiccup; the next tick retries.
  }
}

/** Per-ASIN status rows (the batch's own view). */
function renderBulkItems(items) {
  if (!items.length) return;
  $b('bulkResultCount').textContent =
    `(${items.length} ASIN${items.length === 1 ? '' : 's'})`;
  $b('bulkResultsPanel').classList.remove('hidden');
}

/** Load the full seller-level result set for filtering, sorting and paging. */
async function loadBulkResults() {
  if (!bulk.jobId) return;
  try {
    const response = await fetch(`/api/bulk/jobs/${bulk.jobId}/export.tsv`);
    const tsv = await response.text();
    const lines = tsv.split('\n').filter((line) => line.length > 0);
    if (lines.length < 2) {
      $b('bulkResultsPanel').classList.add('hidden');
      return;
    }
    const headers = lines[0].split('\t');
    bulk.results = lines.slice(1).map((line) => {
      const cells = line.split('\t');
      const row = {};
      headers.forEach((header, index) => {
        row[header] = cells[index] ?? '';
      });
      return row;
    });
    $b('bulkResultsPanel').classList.remove('hidden');
    renderBulkResults();
  } catch (error) {
    banner('error', 'Could not load results', error.message);
  }
}

function renderBulkResults() {
  const term = $b('bulkFilter').value.trim().toLowerCase();
  const market = $b('bulkFilterMarket').value;
  const detection = $b('bulkFilterDetection').value;
  const ful = $b('bulkFilterFul').value;
  const buyboxOnly = $b('bulkFilterBuybox').value === 'yes';
  const sort = $b('bulkSort').value;

  let rows = bulk.results.filter((row) => {
    if (term) {
      const haystack = `${row.ASIN ?? ''} ${row['Seller Name'] ?? ''}`.toLowerCase();
      if (!haystack.includes(term)) return false;
    }
    if (market && (row.Marketplace ?? '') !== market) return false;
    if (detection && (row['Marketplace Detection Status'] ?? '') !== detection) return false;
    if (ful && (row['FBA/FBM'] ?? '') !== ful) return false;
    // Header is "Buy Box" (with a space) — reading `row.BuyBox` silently
    // matched nothing, so the filter and highlight appeared to be dead.
    if (buyboxOnly && row['Buy Box'] !== 'YES') return false;
    return true;
  });

  const numeric = (value) => (value === '' || value === undefined ? Infinity : Number(value));
  if (sort === 'total') rows = [...rows].sort((a, b) => numeric(a['Total Price']) - numeric(b['Total Price']));
  else if (sort === 'price') rows = [...rows].sort((a, b) => numeric(a['Seller Price']) - numeric(b['Seller Price']));
  else if (sort === 'delivery')
    rows = [...rows].sort((a, b) => {
      const left = a['Estimated Delivery Date'] || '9999';
      const right = b['Estimated Delivery Date'] || '9999';
      return left.localeCompare(right);
    });

  $b('bulkResultCount').textContent = `(${rows.length} of ${bulk.results.length} seller rows)`;

  const start = (bulk.page - 1) * bulk.pageSize;
  const page = rows.slice(start, start + bulk.pageSize);
  const pages = Math.max(1, Math.ceil(rows.length / bulk.pageSize));
  if (bulk.page > pages) bulk.page = pages;

  $b('bulkBody').innerHTML = page
    .map((row) => {
      const isBuyBox = row['Buy Box'] === 'YES';
      const status = row['Marketplace Detection Status'] ?? '';
      const tone =
        status === 'CONFIRMED_FOUND' || status === 'MULTIPLE_MARKETPLACES' ? 'det-confirmed'
        : status === 'PROVIDED' ? 'det-provided'
        : 'det-unknown';
      return `<tr class="${isBuyBox ? 'buybox' : ''}">
        <td><span class="mp-tag">${escapeHtml(row['Marketplace Domain'] || row.Marketplace || NA2)}</span></td>
        <td>${escapeHtml(row.ASIN || NA2)}</td>
        <td class="wrap">${escapeHtml(row['Seller Name'] || NA2)}</td>
        <td class="num">${escapeHtml(row['Seller Price'] || NA2)}</td>
        <td class="num">${escapeHtml(row['Shipping Cost'] || NA2)}</td>
        <td class="num">${escapeHtml(row['Total Price'] || NA2)}</td>
        <td>${escapeHtml(row['Estimated Delivery Date'] || NA2)}</td>
        <td class="num">${escapeHtml(row['Delivery Days'] || NA2)}</td>
        <td>${escapeHtml(row['FBA/FBM'] || NA2)}</td>
        <td class="num">${escapeHtml(row['Seller Rating'] || NA2)}</td>
        <td>${isBuyBox ? '<span class="badge buybox">Buy Box</span>' : '<span class="na">—</span>'}</td>
        <td class="${tone}">${escapeHtml(status || NA2)}</td>
        <td>${escapeHtml(row.Status || NA2)}</td>
      </tr>`;
    })
    .join('');

  $b('bulkPageInfo').textContent = `Page ${bulk.page} of ${pages}`;
}

function downloadExport(format) {
  if (!bulk.jobId) return;
  const ext = format === 'tsv' ? 'txt' : 'xlsx';
  window.location.href = `/api/bulk/jobs/${bulk.jobId}/export.${format}`;
  void ext;
}

/**
 * Copy the whole dataset to the clipboard as TSV.
 *
 * The text is fetched fresh from the same endpoint the download uses, so the
 * clipboard always holds every record — not just the visible page.
 */
async function copyAllResults() {
  if (!bulk.jobId) return;
  const button = $b('bulkCopy');
  busy(button, true, 'Copying…');
  try {
    const tsv = await (await fetch(`/api/bulk/jobs/${bulk.jobId}/export.tsv`)).text();
    await navigator.clipboard.writeText(tsv);
    banner('info', 'Copied to clipboard.', 'Paste directly into Excel or Google Sheets — columns align automatically.');
  } catch (error) {
    banner('error', 'Copy failed', error.message);
  } finally {
    busy(button, false);
  }
}