/**
 * Platforma úhrady – frontend logika
 */

const STORAGE_TOKEN = 'platforma_uhrady_token';
const STORAGE_BASE = 'platforma_uhrady_api_base';
const STORAGE_SETTINGS = 'platforma_uhrady_settings';

let state = {
  token: '',
  apiBase: '',
  accounts: [],
  invoices: [],
  selectedIds: new Set(),
};

/** Hodnoty hlavičiek HTTP musia byť ISO-8859-1; odstráni znaky mimo tejto sady. */
function toLatin1(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/[\u0100-\uFFFF]/g, '');
}

function getToken() {
  return document.getElementById('token').value.trim();
}

/** Zadanú URL (aj Swagger) znormalizuje na base URL API (origin bez cesty). */
function getApiBase() {
  const raw = document.getElementById('api-base').value.trim();
  if (!raw) return '';
  try {
    const u = new URL(raw);
    return u.origin;
  } catch (_) {
    return raw;
  }
}

function getAuthHeaders() {
  const token = state.token || getToken();
  const base = state.apiBase || getApiBase();
  return {
    'Authorization': toLatin1('Bearer ' + token),
    'Content-Type': 'application/json',
    'X-Kros-Base-URL': toLatin1(base),
  };
}

function appendApiLog(entry) {
  const el = document.getElementById('api-log');
  if (!el) return;
  const line = '[' + new Date().toLocaleTimeString('sk-SK') + '] ' + entry;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

async function apiCall(path, options = {}) {
  const pathPart = path.startsWith('/') ? path : '/api/' + path.replace(/^\//, '');
  const method = (options.method || 'GET').toUpperCase();
  const bodySerialized = options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
    ? JSON.stringify(options.body)
    : options.body;
  appendApiLog(method + ' ' + pathPart);
  if (bodySerialized != null && bodySerialized !== '') {
    const bodyPreview = typeof bodySerialized === 'string' && bodySerialized.length > 2000
      ? bodySerialized.slice(0, 2000) + '…'
      : bodySerialized;
    appendApiLog('  Body: ' + bodyPreview);
  }
  const headers = { ...getAuthHeaders(), ...(options.headers || {}) };
  if (options.body && typeof options.body === 'object' && !(options.body instanceof FormData)) {
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(pathPart, {
    ...options,
    headers,
    body: bodySerialized,
  });
  const text = await res.text();
  let data = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch (_) {}
  appendApiLog('  → ' + res.status + (res.statusText ? ' ' + res.statusText : ''));
  if (!res.ok && text) {
    const errPreview = text.length > 500 ? text.slice(0, 500) + '…' : text;
    appendApiLog('  Odpoveď: ' + errPreview.replace(/\n/g, ' '));
  }
  if (!res.ok) {
    const err = new Error(data?.error || data?.detail || data?.title || `HTTP ${res.status}`);
    err.status = res.status;
    err.data = data;
    err.retryAfter = res.headers.get('retry-after');
    throw err;
  }
  return data;
}

function showLogin() {
  document.getElementById('login-section').classList.remove('hidden');
  document.getElementById('main-section').classList.add('hidden');
  state.token = '';
  state.invoices = [];
  state.selectedIds.clear();
}

function showMain() {
  document.getElementById('login-section').classList.add('hidden');
  document.getElementById('main-section').classList.remove('hidden');
  document.getElementById('login-error').hidden = true;
  document.getElementById('api-base-label').textContent = 'API: ' + (state.apiBase || getApiBase());
  loadAccounts();
  restoreSettings();
}

function saveSettings() {
  const o = {};
  ['account', 'filter-sequence'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value != null) o[id] = el.value;
  });
  const settingsOpen = document.getElementById('panel-settings')?.classList.contains('expanded');
  const filtersOpen = document.getElementById('panel-filters')?.classList.contains('expanded');
  o._settingsOpen = settingsOpen;
  o._filtersOpen = filtersOpen;
  try {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(o));
  } catch (_) {}
}

function restoreSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (!raw) return;
    const o = JSON.parse(raw);
    ['filter-sequence'].forEach(id => {
      const el = document.getElementById(id);
      if (el && o[id] != null) el.value = o[id];
    });
    if (o.account != null) {
      const sel = document.getElementById('account');
      if (sel && o.account !== '') sel.value = o.account;
    }
    if (o._settingsOpen) document.getElementById('panel-settings')?.classList.add('expanded');
    if (o._filtersOpen) document.getElementById('panel-filters')?.classList.add('expanded');
    const sBtn = document.getElementById('toggle-settings');
    const fBtn = document.getElementById('toggle-filters');
    if (sBtn) sBtn.setAttribute('aria-expanded', !!o._settingsOpen);
    if (fBtn) fBtn.setAttribute('aria-expanded', !!o._filtersOpen);
  } catch (_) {}
}

function persistToken() {
  const remember = document.getElementById('remember-token')?.checked;
  const token = getToken();
  if (remember && token) {
    localStorage.setItem(STORAGE_TOKEN, token);
    localStorage.setItem(STORAGE_BASE, getApiBase());
  } else {
    localStorage.removeItem(STORAGE_TOKEN);
    localStorage.removeItem(STORAGE_BASE);
  }
}

function restoreSaved() {
  const saved = localStorage.getItem(STORAGE_TOKEN);
  const base = localStorage.getItem(STORAGE_BASE);
  if (saved) {
    document.getElementById('token').value = saved;
    document.getElementById('remember-token').checked = true;
  }
  if (base) {
    document.getElementById('api-base').value = base;
  }
}

async function connect() {
  const token = getToken();
  const apiBase = getApiBase();
  if (!token) {
    showError('login-error', 'Zadajte API token.');
    return;
  }
  const btn = document.getElementById('btn-connect');
  btn.disabled = true;
  document.getElementById('login-error').hidden = true;
  try {
    state.token = token;
    state.apiBase = apiBase;
    // Overíme, či odpovedá náš server (ak nie, používateľ pravdepodobne otvoril stránku zo súboru alebo z inej adresy)
    try {
      const pingRes = await fetch('/api/ping', { method: 'GET' });
      if (pingRes.status === 404) {
        showError('login-error',
          'Spustite aplikáciu príkazom „npm start“ v priečinku projektu a otvorte v prehliadači http://localhost:3000.');
        return;
      }
    } catch (pingErr) {
      showError('login-error',
        'Nepodarilo sa spojiť so serverom. Spustite „npm start“ a otvorte http://localhost:3000. Chyba: ' + (pingErr.message || 'sieťová chyba'));
      return;
    }
    await apiCall('/api/auth/check', { method: 'GET' });
    persistToken();
    showMain();
  } catch (e) {
    if (e.status === 401) {
      showError('login-error', 'Neplatný token. Skontrolujte token v nastavení fakturacia.kros.sk.');
    } else if (e.status === 404) {
      showError('login-error',
        'KROS API vrátilo 404. Skontrolujte: 1) či beží server (npm start) a otvárate http://localhost:3000, 2) či je URL KROS API správna (testovacia: esw-testlab-openapigateway-api.azurewebsites.net).');
    } else {
      showError('login-error', e.message || 'Pripojenie zlyhalo.');
    }
  } finally {
    btn.disabled = false;
  }
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (!el) return;
  el.textContent = msg;
  el.hidden = false;
  el.className = 'error-box';
}

function showResult(id, msg, type = 'success') {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = msg;
  el.hidden = false;
  el.className = 'result-box ' + type;
}

async function loadAccounts() {
  const sel = document.getElementById('account');
  sel.innerHTML = '<option value="">— načítavam —</option>';
  try {
    const res = await apiCall('/api/payments/accounts', { method: 'GET' });
    const list = res?.data || [];
    state.accounts = list;
    sel.innerHTML = '<option value="">— vyberte účet —</option>' + list.map(a =>
      `<option value="${a.id}">${escapeHtml(a.name || 'Účet')} ${a.iban ? ' • ' + a.iban : ''} (${a.currency || 'EUR'})</option>`
    ).join('');
    const saved = (() => { try { const r = localStorage.getItem(STORAGE_SETTINGS); return r ? JSON.parse(r) : null; } catch (_) { return null; } })();
    if (saved?.account) sel.value = saved.account;
  } catch (e) {
    sel.innerHTML = '<option value="">Chyba načítania účtov</option>';
    if (e.status === 401) showLogin();
  }
}

function escapeHtml(s) {
  if (s == null) return '';
  const div = document.createElement('div');
  div.textContent = s;
  return div.innerHTML;
}

/** Zaokrúhli sumu na 2 desatinné miesta (odstráni chyby plávajúcej desatinnej čiarky). */
function roundCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/**
 * Pre platbu: ak je variabilný symbol dlhší ako 10 znakov alebo obsahuje iné ako číslice,
 * vráti { variableSymbol: '', reference: raw } (celý text do referencie). Inak { variableSymbol: vs (max 10), reference: undefined }.
 */
function getVariableSymbolAndReference(inv) {
  const raw = (inv.variableSymbol ?? '').toString().trim();
  if (!raw) return { variableSymbol: '', reference: undefined };
  const tooLong = raw.length > 10;
  const hasNonDigit = /[^0-9]/.test(raw);
  if (tooLong || hasNonDigit) {
    return { variableSymbol: '', reference: raw };
  }
  return { variableSymbol: raw.slice(0, 10), reference: undefined };
}

/** Rozdiel k úhrade v mene dokladu: sumForPayment − sumOfPayments (môže byť záporný – preplatené / dobropis). */
function getSumForPayment(inv) {
  const forPayment = Number(inv.sumForPayment ?? inv.prices?.documentPrices?.totalPriceInclVat ?? 0);
  const paid = Number(inv.sumOfPayments ?? 0);
  return roundCurrency(forPayment - paid);
}

/** Rozdiel k úhrade v legislatívnej mene (pre zobrazenie a platby). */
function getSumForPaymentLegislative(inv) {
  const docSum = getSumForPayment(inv);
  const docTotal = Number(inv.prices?.documentPrices?.totalPriceInclVat ?? 0);
  const legTotal = Number(inv.prices?.legislativePrices?.totalPriceInclVat ?? 0);
  if (docTotal <= 0) return roundCurrency(docSum);
  return roundCurrency((docSum / docTotal) * legTotal);
}

async function handleImportFile() {
  const input = document.getElementById('input-import-file');
  const file = input?.files?.[0];
  const sequence = (document.getElementById('filter-sequence')?.value || '').trim();
  if (!file) return;
  document.getElementById('invoices-loading').hidden = false;
  document.getElementById('invoices-table-wrap').hidden = true;
  document.getElementById('invoices-empty').hidden = true;
  document.getElementById('pagination').hidden = true;
  const formData = new FormData();
  formData.append('file', file);
  try {
    const params = new URLSearchParams();
    if (sequence) params.set('NumberingSequence', sequence);
    const importUrl = '/api/import/invoices' + (params.toString() ? `?${params.toString()}` : '');
    const res = await fetch(importUrl, {
      method: 'POST',
      body: formData,
      headers: getAuthHeaders().Authorization ? { 'Authorization': getAuthHeaders().Authorization } : {},
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(data.error || res.statusText || 'Chyba importu');
    }
    const list = data?.data || [];
    state.invoices = list;
    state.selectedIds.clear();
    renderInvoices();
    document.getElementById('invoices-loading').hidden = true;
    if (state.invoices.length === 0) {
      document.getElementById('invoices-empty').hidden = false;
      document.getElementById('invoices-empty').textContent = sequence
        ? 'Žiadna položka nevyhovuje filtru číselného radu.'
        : 'V súbore neboli žiadne platné riadky.';
    } else {
      document.getElementById('invoices-table-wrap').hidden = false;
    }
    const wrap = document.getElementById('pagination');
    wrap.hidden = true;
    wrap.innerHTML = '';
    const info = document.createElement('span');
    info.textContent = `Načítaných ${state.invoices.length} dokladov zo súboru.`;
    wrap.appendChild(info);
    wrap.hidden = false;
  } catch (e) {
    document.getElementById('invoices-loading').hidden = true;
    document.getElementById('invoices-empty').hidden = false;
    document.getElementById('invoices-empty').textContent = 'Chyba: ' + (e.message || 'import zlyhal.');
  }
  input.value = '';
}

async function loadInvoices(skip = 0) {
  const sequence = (document.getElementById('filter-sequence')?.value || '').trim();
  const params = new URLSearchParams({
    PaymentStatus: '0',
    Top: '100',
    Skip: String(skip),
  });
  if (sequence) params.set('NumberingSequence', sequence);

  document.getElementById('invoices-loading').hidden = false;
  document.getElementById('invoices-table-wrap').hidden = true;
  document.getElementById('invoices-empty').hidden = true;
  document.getElementById('pagination').hidden = true;

  try {
    const res = await apiCall('/api/invoices?' + params.toString(), { method: 'GET' });
    const list = res?.data || [];
    if (skip === 0) state.invoices = list;
    else state.invoices = state.invoices.concat(list);
    renderInvoices();
    const hasMore = list.length === 100;
    document.getElementById('invoices-loading').hidden = true;
    if (state.invoices.length === 0 && !hasMore) {
      document.getElementById('invoices-empty').hidden = false;
      document.getElementById('invoices-empty').textContent = sequence
        ? 'Žiadna faktúra nevyhovuje filtru číselného radu.'
        : 'Žiadne neuhradené faktúry.';
    } else {
      document.getElementById('invoices-table-wrap').hidden = false;
    }
    renderPagination(skip, hasMore);
  } catch (e) {
    document.getElementById('invoices-loading').hidden = true;
    document.getElementById('invoices-empty').hidden = false;
    document.getElementById('invoices-empty').textContent = 'Chyba: ' + (e.message || e.status);
    if (e.status === 401) showLogin();
  }
}

function renderPagination(skip, hasMore) {
  const wrap = document.getElementById('pagination');
  if (state.invoices.length === 0 && !hasMore) {
    wrap.hidden = true;
    return;
  }
  wrap.hidden = false;
  wrap.innerHTML = '';
  if (skip > 0) {
    const prev = document.createElement('button');
    prev.textContent = '← Predchádzajúce';
    prev.onclick = () => loadInvoices(Math.max(0, skip - 100));
    wrap.appendChild(prev);
  }
  const info = document.createElement('span');
  info.textContent = `Načítaných ${state.invoices.length} faktúr.`;
  wrap.appendChild(info);
  if (hasMore) {
    const next = document.createElement('button');
    next.textContent = 'Ďalších 100 →';
    next.onclick = () => loadInvoices(skip + 100);
    wrap.appendChild(next);
  }
}

function renderInvoices() {
  const tbody = document.getElementById('invoices-tbody');
  const list = state.invoices;
  tbody.innerHTML = list.map(inv => {
    const sumLegislative = getSumForPaymentLegislative(inv);
    const docTotal = Number(inv.prices?.documentPrices?.totalPriceInclVat ?? 0);
    const docPaid = Number(inv.sumOfPayments ?? 0);
    const docCurrency = (inv.prices?.currency || 'EUR').trim();
    const checked = state.selectedIds.has(String(inv.id));
    const partnerName = inv.partner?.address?.businessName || '—';
    const issueDate = inv.issueDate ? new Date(inv.issueDate).toLocaleDateString('sk-SK') : '—';
    const dueDate = inv.dueDate ? new Date(inv.dueDate).toLocaleDateString('sk-SK') : '—';
    const vs = inv.variableSymbol || '—';
    const docLine1 = [inv.numberingSequence, inv.documentNumber].filter(Boolean).join(' ') || '—';
    const forPayment = Number(inv.sumForPayment ?? inv.prices?.documentPrices?.totalPriceInclVat ?? 0);
    const sumDocLine = docTotal > 0 ? `${docTotal.toFixed(2)} ${docCurrency}` : '—';
    const sumTooltip = `sumForPayment: ${forPayment.toFixed(2)} | sumOfPayments: ${docPaid.toFixed(2)} | Rozdiel (na úhradu): ${sumLegislative.toFixed(2)} €`;
    return `
      <tr class="${checked ? 'selected' : ''}" data-id="${inv.id}">
        <td class="col-check"><input type="checkbox" class="inv-check" data-id="${inv.id}" ${checked ? 'checked' : ''}></td>
        <td class="col-doc" title="${escapeHtml(partnerName)}">
          <span class="cell-l1">${escapeHtml(docLine1)}</span>
          <span class="cell-l2 cell-truncate">${escapeHtml(partnerName)}</span>
        </td>
        <td class="col-dates">
          <span class="cell-l1">${issueDate}</span>
          <span class="cell-l2">${dueDate}</span>
        </td>
        <td class="col-sum number" title="${escapeHtml(sumTooltip)}">
          <span class="cell-l1 cell-sum-doc">${escapeHtml(sumDocLine)}</span>
          <span class="cell-l2">${sumLegislative.toFixed(2)} €</span>
        </td>
        <td class="col-vs"><span class="cell-l2">${escapeHtml(vs)}</span></td>
        <td class="col-action"><button type="button" class="btn btn-primary btn-sm btn-pay-one" data-id="${inv.id}">Uhradiť</button></td>
      </tr>`;
  }).join('');

  /** Normalizuje id (API = number, import = string) pre porovnanie. */
  function normId(id) {
    if (id === undefined || id === null) return '';
    const s = String(id);
    return s;
  }

  tbody.querySelectorAll('.btn-pay-one').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      const id = normId(btn.dataset.id);
      const inv = state.invoices.find(i => normId(i.id) === id);
      if (inv) paySingleInvoice(inv);
    });
  });

  tbody.querySelectorAll('.inv-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const id = normId(cb.dataset.id);
      if (cb.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      toggleRow(cb);
      updateSelectedCount();
    });
  });

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', ev => {
      if (ev.target.tagName === 'INPUT' || ev.target.closest('button')) return;
      const id = normId(tr.dataset.id);
      const cb = tr.querySelector('.inv-check');
      if (!cb) return;
      cb.checked = !cb.checked;
      if (cb.checked) state.selectedIds.add(id);
      else state.selectedIds.delete(id);
      toggleRow(cb);
      updateSelectedCount();
    });
  });

  document.getElementById('check-all').checked = list.length > 0 && list.every(inv => state.selectedIds.has(normId(inv.id)));
  document.getElementById('check-all').indeterminate = list.length > 0 && state.selectedIds.size > 0 && state.selectedIds.size < list.length;
  updateSelectedCount();
}

function toggleRow(cb) {
  const tr = cb.closest('tr');
  if (cb.checked) tr?.classList.add('selected');
  else tr?.classList.remove('selected');
}

function updateSelectedCount() {
  const n = state.selectedIds.size;
  document.getElementById('selected-count').textContent = n ? `Vybraných: ${n}` : '';
  document.getElementById('btn-submit-payments').disabled = n === 0 || !document.getElementById('account').value;
}

function selectAll() {
  state.invoices.forEach(inv => state.selectedIds.add(String(inv.id)));
  state.invoices.forEach(inv => {
    const cb = document.querySelector(`.inv-check[data-id="${inv.id}"]`);
    if (cb) cb.checked = true;
  });
  document.querySelectorAll('#invoices-tbody tr').forEach(tr => tr.classList.add('selected'));
  document.getElementById('check-all').checked = true;
  document.getElementById('check-all').indeterminate = false;
  updateSelectedCount();
}

function selectNone() {
  state.selectedIds.clear();
  document.querySelectorAll('.inv-check').forEach(cb => { cb.checked = false; });
  document.querySelectorAll('#invoices-tbody tr').forEach(tr => tr.classList.remove('selected'));
  document.getElementById('check-all').checked = false;
  document.getElementById('check-all').indeterminate = false;
  updateSelectedCount();
}

/** Dátum faktúry vo formáte yyyy-MM-dd pre API. */
function getIssueDateYmd(inv) {
  const d = inv.issueDate;
  if (!d) return new Date().toISOString().slice(0, 10);
  return String(d).slice(0, 10);
}

async function paySingleInvoice(inv) {
  const accountId = document.getElementById('account').value;
  if (!accountId) {
    showResult('submit-result', 'Vyberte bankový účet pre úhrady.', 'error');
    return;
  }
  const sumDoc = getSumForPayment(inv);
  const sumLeg = getSumForPaymentLegislative(inv);
  const docCurrency = inv.prices?.currency || 'EUR';
  const partnerName = (inv.partner?.address?.businessName || '').toString().slice(0, 255);
  const { variableSymbol: vsPay, reference: refPay } = getVariableSymbolAndReference(inv);
  const paymentItem = {
    dateOfPayment: getIssueDateYmd(inv),
    sumOfPayment: sumLeg,
    originalSumOfPayment: sumDoc,
    originalCurrency: docCurrency,
    variableSymbol: vsPay,
    partnerName: partnerName || undefined,
    accountId: Number(accountId),
  };
  if (refPay !== undefined) paymentItem.paymentReference = refPay;
  const data = [paymentItem];
  document.getElementById('submit-result').hidden = true;
  const btn = document.querySelector(`.btn-pay-one[data-id="${inv.id}"]`);
  const row = btn?.closest('tr');
  const originalText = btn?.textContent ?? 'Uhradiť';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Spracováva sa...';
  }
  try {
    const res = await apiCall('/api/payments/batch', { method: 'POST', body: { data } });
    const requestId = res?.requestId || '';
    showResult('submit-result',
      `Platba pre faktúru ${inv.documentNumber || inv.id} odoslaná (202). RequestId: ${requestId}.`,
      'success');
    if (btn) {
      btn.textContent = '✓ Uhradené';
      btn.classList.remove('btn-primary');
      btn.classList.add('btn-success');
      if (row) row.classList.add('row-paid');
    }
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    if (e.status === 401) showLogin();
    else if (e.status === 408) {
      showResult('submit-result', 'Vypršal časový limit požiadavky (408). KROS API neodpovedalo včas. Skúste to znova o chvíľu.', 'warning');
    } else if (e.status === 409) {
      showResult('submit-result', 'Duplicitná požiadavka. Počkajte cca 120 s a skúste znova.', 'warning');
    } else if (e.status === 429) {
      showResult('submit-result', 'Príliš veľa požiadaviek (429). Počkajte a skúste znova.', 'warning');
    } else if (e.status === 400 && e.data?.errors) {
      const list = e.data.errors.map(x => `${x.propertyPath || '?'}: ${x.errorMessage || ''}`).join('<br>');
      showResult('submit-result', 'Chyby:<br>' + list, 'error');
    } else {
      showResult('submit-result', 'Chyba: ' + (e.message || e.status), 'error');
    }
  }
}

async function submitPayments() {
  const accountId = document.getElementById('account').value;
  if (!accountId) {
    showResult('submit-result', 'Vyberte bankový účet.', 'error');
    return;
  }
  const toPay = state.invoices.filter(inv => state.selectedIds.has(String(inv.id)));
  if (toPay.length === 0) {
    showResult('submit-result', 'Nevybrali ste žiadnu faktúru.', 'error');
    return;
  }
  const data = toPay.map(inv => {
    const sumDoc = getSumForPayment(inv);
    const sumLeg = getSumForPaymentLegislative(inv);
    const docCurrency = inv.prices?.currency || 'EUR';
    const partnerName = (inv.partner?.address?.businessName || '').toString().slice(0, 255);
    const { variableSymbol: vsPay, reference: refPay } = getVariableSymbolAndReference(inv);
    const item = {
      dateOfPayment: getIssueDateYmd(inv),
      sumOfPayment: sumLeg,
      originalSumOfPayment: sumDoc,
      originalCurrency: docCurrency,
      variableSymbol: vsPay,
      partnerName: partnerName || undefined,
      accountId: Number(accountId),
    };
    if (refPay !== undefined) item.paymentReference = refPay;
    return item;
  });

  document.getElementById('submit-result').hidden = true;
  const btn = document.getElementById('btn-submit-payments');
  btn.disabled = true;
  try {
    const res = await apiCall('/api/payments/batch', {
      method: 'POST',
      body: { data },
    });
    const requestId = res?.requestId || '';
    showResult('submit-result',
      `Platby boli odoslané (202 Accepted). RequestId: ${requestId}. Výsledok spracovania príde cez váš callback v KROS Fakturácii.`,
      'success');
    state.selectedIds.clear();
    renderInvoices();
  } catch (e) {
    if (e.status === 401) {
      showLogin();
      return;
    }
    if (e.status === 408) {
      showResult('submit-result',
        'Vypršal časový limit požiadavky (408). KROS API neodpovedalo včas. Skúste to znova o chvíľu.',
        'warning');
      return;
    }
    if (e.status === 409) {
      showResult('submit-result',
        'Duplicitná požiadavka. Rovnaký request bol nedávno odoslaný. Počkajte cca 120 s a skúste znova.',
        'warning');
      return;
    }
    if (e.status === 429) {
      const retry = e.retryAfter || e.data?.retryAfter || '60';
      showResult('submit-result', `Príliš veľa požiadaviek (429). Počkajte ${retry} s a skúste znova.`, 'warning');
      return;
    }
    if (e.status === 400 && e.data?.errors) {
      const list = e.data.errors.map(x => `${x.propertyPath || '?'}: ${x.errorMessage || ''}`).join('<br>');
      showResult('submit-result', 'Validačné chyby:<br>' + list, 'error');
      return;
    }
    showResult('submit-result', 'Chyba: ' + (e.message || e.status), 'error');
  } finally {
    btn.disabled = false;
  }
}

function bindEvents() {
  document.getElementById('btn-connect').addEventListener('click', connect);
  document.getElementById('btn-logout').addEventListener('click', () => {
    state.token = '';
    localStorage.removeItem(STORAGE_TOKEN);
    showLogin();
  });
  document.getElementById('btn-restart')?.addEventListener('click', async () => {
    const btn = document.getElementById('btn-restart');
    if (btn?.disabled) return;
    btn.disabled = true;
    try {
      await apiCall('/api/restart', { method: 'POST' });
      showResult('submit-result', 'Služba sa reštartuje. Obnovte stránku o pár sekúnd (F5).', 'success');
    } catch (e) {
      if (e.status === 403) {
        showResult('submit-result', 'Reštart je povolený len pri behu na localhoste. V termináli použite Ctrl+C a potom npm start.', 'warning');
      } else {
        showResult('submit-result', 'Chyba: ' + (e.message || e.status), 'error');
      }
    } finally {
      btn.disabled = false;
    }
  });
  document.getElementById('btn-load-invoices').addEventListener('click', () => loadInvoices(0));
  document.getElementById('btn-load-from-file').addEventListener('click', () => document.getElementById('input-import-file').click());
  document.getElementById('input-import-file').addEventListener('change', handleImportFile);
  document.getElementById('btn-select-all').addEventListener('click', selectAll);
  document.getElementById('btn-select-none').addEventListener('click', selectNone);
  document.getElementById('btn-submit-payments').addEventListener('click', submitPayments);

  document.getElementById('check-all').addEventListener('change', function () {
    if (this.checked) selectAll();
    else selectNone();
  });

  const sequenceInput = document.getElementById('filter-sequence');
  if (sequenceInput) {
    sequenceInput.addEventListener('input', () => { saveSettings(); });
    sequenceInput.addEventListener('change', () => { saveSettings(); loadInvoices(0); });
    sequenceInput.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        saveSettings();
        loadInvoices(0);
      }
    });
  }

  document.getElementById('account')?.addEventListener('change', () => { updateSelectedCount(); saveSettings(); });

  document.getElementById('toggle-settings')?.addEventListener('click', () => {
    const panel = document.getElementById('panel-settings');
    const btn = document.getElementById('toggle-settings');
    if (!panel || !btn) return;
    panel.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', panel.classList.contains('expanded'));
    saveSettings();
  });
  document.getElementById('toggle-filters')?.addEventListener('click', () => {
    const panel = document.getElementById('panel-filters');
    const btn = document.getElementById('toggle-filters');
    if (!panel || !btn) return;
    panel.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', panel.classList.contains('expanded'));
    saveSettings();
  });
  document.getElementById('toggle-api-log')?.addEventListener('click', () => {
    const panel = document.getElementById('panel-api-log');
    const btn = document.getElementById('toggle-api-log');
    if (!panel || !btn) return;
    panel.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', panel.classList.contains('expanded'));
  });
  document.getElementById('btn-clear-api-log')?.addEventListener('click', () => {
    const el = document.getElementById('api-log');
    if (el) el.textContent = '';
  });
}

function init() {
  restoreSaved();
  bindEvents();
  if (state.invoices.length === 0) {
    document.getElementById('invoices-empty').hidden = false;
    document.getElementById('invoices-table-wrap').hidden = true;
  }
}

init();
