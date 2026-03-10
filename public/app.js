/**
 * Platforma úhrady – frontend logika
 */

const STORAGE_TOKEN = 'platforma_uhrady_token';
const STORAGE_BASE = 'platforma_uhrady_api_base';
const STORAGE_SETTINGS = 'platforma_uhrady_settings';
const STORAGE_TRANSFER = 'platforma_uhrady_transfer';

let state = {
  token: '',
  apiBase: '',
  accounts: [],
  invoices: [],
  selectedIds: new Set(),
};

let transferState = {
  payments: [],
  filteredPayments: [],
  transferredIds: new Set(),
  selectedIds: new Set(),
  currentSkip: 0,
  hasMore: false,
};

/** Hodnoty hlavičiek HTTP musia byť ISO-8859-1; odstráni znaky mimo tejto sady. */
function toLatin1(str) {
  if (str == null || typeof str !== 'string') return '';
  return str.replace(/[\u0100-\uFFFF]/g, '');
}

function getToken() {
  return document.getElementById('token').value.trim();
}

function setApiBase(url) {
  document.getElementById('api-base').value = url;
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.classList.toggle('env-btn-active', btn.dataset.url === url);
  });
}

/** Vráti base URL API z hidden inputu. */
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

function appendApiLog(entry, logId = 'api-log') {
  const el = document.getElementById(logId);
  if (!el) return;
  const line = '[' + new Date().toLocaleTimeString('sk-SK') + '] ' + entry;
  el.textContent = (el.textContent ? el.textContent + '\n' : '') + line;
  el.scrollTop = el.scrollHeight;
}

function appendTransferApiLog(entry) {
  appendApiLog(entry, 'transfer-api-log');
}

async function apiCall(path, options = {}, logId = 'api-log') {
  const pathPart = path.startsWith('/') ? path : '/api/' + path.replace(/^\//, '');
  const method = (options.method || 'GET').toUpperCase();
  const bodySerialized = options.body && typeof options.body === 'object' && !(options.body instanceof FormData)
    ? JSON.stringify(options.body)
    : options.body;
  appendApiLog(method + ' ' + pathPart, logId);
  if (bodySerialized != null && bodySerialized !== '') {
    const bodyPreview = typeof bodySerialized === 'string' && bodySerialized.length > 2000
      ? bodySerialized.slice(0, 2000) + '…'
      : bodySerialized;
    appendApiLog('  Body: ' + bodyPreview, logId);
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
  appendApiLog('  → ' + res.status + (res.statusText ? ' ' + res.statusText : ''), logId);
  if (!res.ok && text) {
    const errPreview = text.length > 500 ? text.slice(0, 500) + '…' : text;
    appendApiLog('  Odpoveď: ' + errPreview.replace(/\n/g, ' '), logId);
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

function apiCallTransfer(path, options = {}) {
  return apiCall(path, options, 'transfer-api-log');
}

function hideAllSections() {
  ['login-section', 'module-picker', 'main-section', 'transfer-section'].forEach(id => {
    document.getElementById(id)?.classList.add('hidden');
  });
}

function showLogin() {
  hideAllSections();
  document.getElementById('login-section').classList.remove('hidden');
  state.token = '';
  state.invoices = [];
  state.selectedIds.clear();
}

function showModulePicker() {
  hideAllSections();
  document.getElementById('module-picker').classList.remove('hidden');
  document.getElementById('login-error').hidden = true;
}

function showMain() {
  hideAllSections();
  document.getElementById('main-section').classList.remove('hidden');
  document.getElementById('api-base-label').textContent = 'API: ' + (state.apiBase || getApiBase());
  loadAccounts();
  restoreSettings();
  loadInvoices(0);
}

async function showTransfer() {
  hideAllSections();
  document.getElementById('transfer-section').classList.remove('hidden');
  document.getElementById('transfer-api-base-label').textContent = 'API: ' + (state.apiBase || getApiBase());
  await loadTransferAccounts();
  const srcId = document.getElementById('transfer-src-account')?.value;
  const dstId = document.getElementById('transfer-dst-account')?.value;
  if (srcId && dstId && srcId !== dstId) {
    loadTransferPayments();
  }
}

function saveSettings() {
  const o = {};
  ['account', 'filter-sequence', 'filter-date-from', 'filter-date-to'].forEach(id => {
    const el = document.getElementById(id);
    if (el && el.value != null) o[id] = el.value;
  });

  try {
    localStorage.setItem(STORAGE_SETTINGS, JSON.stringify(o));
  } catch (_) {}
}

function restoreSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_SETTINGS);
    if (!raw) return;
    const o = JSON.parse(raw);
    ['filter-sequence', 'filter-date-from', 'filter-date-to'].forEach(id => {
      const el = document.getElementById(id);
      if (el && o[id] != null) el.value = o[id];
    });
    if (o.account != null) {
      const sel = document.getElementById('account');
      if (sel && o.account !== '') sel.value = o.account;
    }
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
    setApiBase(base);
  } else {
    setApiBase(document.getElementById('api-base').value);
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
    showModulePicker();
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
  const { from: dateFrom, to: dateTo } = getDateRange('filter-date-from', 'filter-date-to');
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
    if (dateFrom) params.set('DateFrom', dateFrom);
    if (dateTo) params.set('DateTo', dateTo);
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
      document.getElementById('invoices-empty').textContent = (sequence || dateFrom || dateTo)
        ? 'Žiadna položka nevyhovuje zadaným filtrom.'
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
  const { from: dateFrom, to: dateTo } = getDateRange('filter-date-from', 'filter-date-to');
  const params = new URLSearchParams({
    PaymentStatus: '0',
    Top: '100',
    Skip: String(skip),
  });
  if (sequence) params.set('NumberingSequence', sequence);
  if (dateFrom) params.set('DateFrom', dateFrom);
  if (dateTo) params.set('DateTo', dateTo);

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
      document.getElementById('invoices-empty').textContent = (sequence || dateFrom || dateTo)
        ? 'Žiadna faktúra nevyhovuje zadaným filtrom.'
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

/* ============================================================
   PREVOD MEDZI ÚČTAMI
   ============================================================ */

function saveTransferSettings() {
  try {
    const o = {
      src: document.getElementById('transfer-src-account')?.value || '',
      dst: document.getElementById('transfer-dst-account')?.value || '',
      dateFrom: document.getElementById('transfer-date-from')?.value || '',
      dateTo: document.getElementById('transfer-date-to')?.value || '',
    };
    localStorage.setItem(STORAGE_TRANSFER, JSON.stringify(o));
  } catch (_) {}
}

function getDateRange(fromInputId, toInputId) {
  const fromRaw = (document.getElementById(fromInputId)?.value || '').trim();
  const toRaw = (document.getElementById(toInputId)?.value || '').trim();
  if (fromRaw && toRaw && fromRaw > toRaw) {
    return { from: toRaw, to: fromRaw };
  }
  return { from: fromRaw, to: toRaw };
}

/** Vytvorí deterministický kľúč pre platbu z dostupných polí (API nevracia vlastné ID). */
function makePaymentKey(p) {
  const date = (p.dateOfPayment || '').slice(0, 10);
  const sum = p.sumOfPayment != null ? String(p.sumOfPayment) : '';
  const vs = p.variableSymbol || '';
  const ref = p.paymentReference || '';
  return [date, sum, vs, ref].join('|');
}

async function loadTransferAccounts() {
  const srcSel = document.getElementById('transfer-src-account');
  const dstSel = document.getElementById('transfer-dst-account');
  srcSel.innerHTML = '<option value="">— načítavam —</option>';
  dstSel.innerHTML = '<option value="">— načítavam —</option>';
  try {
    const res = await apiCallTransfer('/api/payments/accounts', { method: 'GET' });
    const list = res?.data || [];
    state.accounts = list;
    const opts = '<option value="">— vyberte účet —</option>' + list.map(a =>
      `<option value="${a.id}">${escapeHtml(a.name || 'Účet')}${a.iban ? ' • ' + a.iban : ''} (${a.currency || 'EUR'})</option>`
    ).join('');
    srcSel.innerHTML = opts;
    dstSel.innerHTML = opts;
    // Obnov posledne zvolené účty
    try {
      const saved = JSON.parse(localStorage.getItem(STORAGE_TRANSFER) || '{}');
      if (saved.src) srcSel.value = saved.src;
      if (saved.dst) dstSel.value = saved.dst;
      const transferDateFrom = document.getElementById('transfer-date-from');
      const transferDateTo = document.getElementById('transfer-date-to');
      if (transferDateFrom && saved.dateFrom) transferDateFrom.value = saved.dateFrom;
      if (transferDateTo && saved.dateTo) transferDateTo.value = saved.dateTo;
    } catch (_) {}
  } catch (e) {
    srcSel.innerHTML = '<option value="">Chyba načítania účtov</option>';
    dstSel.innerHTML = '<option value="">Chyba načítania účtov</option>';
    if (e.status === 401) showLogin();
  }
}

async function fetchAllPayments(accountId, dateFrom, dateTo) {
  let all = [];
  let skip = 0;
  while (true) {
    const params = new URLSearchParams({ accountId: String(accountId), Top: '100', Skip: String(skip) });
    if (dateFrom) params.set('DateFrom', dateFrom);
    if (dateTo) params.set('DateTo', dateTo);
    const url = '/api/payments?' + params.toString();
    const res = await apiCallTransfer(url, { method: 'GET' });
    appendTransferApiLog('  Odpoveď (skrátene): ' + JSON.stringify(res)?.slice(0, 300));
    const batch = res?.data || res?.items || res?.payments || (Array.isArray(res) ? res : []);
    all = all.concat(batch);
    if (batch.length === 0) break;
    const rawCount = Number(res?.meta?.rawCount);
    if ((Number.isFinite(rawCount) && rawCount < 100) || batch.length < 100) {
      break;
    }
    skip += 100;
  }
  return all;
}

async function loadTransferPayments() {
  const srcId = document.getElementById('transfer-src-account').value;
  const dstId = document.getElementById('transfer-dst-account').value;
  const { from: dateFrom, to: dateTo } = getDateRange('transfer-date-from', 'transfer-date-to');
  if (!srcId) {
    showTransferResult('Vyberte zdrojový účet.', 'error');
    return;
  }
  if (!dstId) {
    showTransferResult('Vyberte cieľový účet.', 'error');
    return;
  }
  if (srcId === dstId) {
    showTransferResult('Zdrojový a cieľový účet musia byť rôzne.', 'error');
    return;
  }

  document.getElementById('transfer-loading').hidden = false;
  document.getElementById('transfer-table-wrap').hidden = true;
  document.getElementById('transfer-empty').hidden = true;
  document.getElementById('transfer-pagination').hidden = true;
  document.getElementById('transfer-result').hidden = true;
  transferState.payments = [];
  transferState.filteredPayments = [];
  transferState.transferredIds = new Set();
  transferState.selectedIds = new Set();

  try {
    const [srcPayments, dstPayments] = await Promise.all([
      fetchAllPayments(srcId, dateFrom, dateTo),
      fetchAllPayments(dstId, dateFrom, dateTo),
    ]);

    dstPayments.forEach(p => {
      if (p.externalId != null && p.externalId !== '') {
        transferState.transferredIds.add(String(p.externalId));
      }
    });

    // Priradíme každej zdrojovej platbe stabilný kľúč ak ho ešte nemá
    srcPayments.forEach(p => {
      if (!p._pid) p._pid = makePaymentKey(p);
    });

    transferState.payments = srcPayments;
    applyTransferFilter();

    document.getElementById('transfer-loading').hidden = true;
    if (srcPayments.length === 0) {
      document.getElementById('transfer-empty').hidden = false;
      document.getElementById('transfer-empty').textContent = 'Na zdrojovom účte nie sú žiadne platby.';
    } else {
      document.getElementById('transfer-table-wrap').hidden = false;
    }
  } catch (e) {
    document.getElementById('transfer-loading').hidden = true;
    document.getElementById('transfer-empty').hidden = false;
    document.getElementById('transfer-empty').textContent = 'Chyba: ' + (e.message || e.status);
    if (e.status === 401) showLogin();
  }
}

function applyTransferFilter() {
  const filterText = (document.getElementById('transfer-partner-filter')?.value || '').trim().toLowerCase();
  const statusFilter = document.querySelector('#transfer-status-filter .toggle-btn-active')?.dataset.value || 'all';

  transferState.filteredPayments = transferState.payments.filter(p => {
    if (filterText) {
      const partner = (p.partnerName || '').toLowerCase();
      if (!partner.includes(filterText)) return false;
    }
    if (statusFilter !== 'all') {
      const pid = p._pid || makePaymentKey(p);
      const isTransferred = transferState.transferredIds.has(pid);
      if (statusFilter === 'transferred' && !isTransferred) return false;
      if (statusFilter === 'notTransferred' && isTransferred) return false;
    }
    return true;
  });
  renderTransferPayments();
}

function renderTransferPayments() {
  const tbody = document.getElementById('transfer-tbody');
  const list = transferState.filteredPayments;
  const total = transferState.payments.length;
  const countEl = document.getElementById('transfer-count-label');
  if (countEl) {
    countEl.textContent = total > 0
      ? (list.length < total ? `${list.length} z ${total}` : `${total}`)
      : '';
  }

  if (list.length === 0) {
    document.getElementById('transfer-table-wrap').hidden = true;
    document.getElementById('transfer-empty').hidden = false;
    document.getElementById('transfer-empty').textContent = 'Žiadne platby nevyhovujú filtru.';
    updateTransferSelectedCount();
    return;
  }

  document.getElementById('transfer-table-wrap').hidden = false;
  document.getElementById('transfer-empty').hidden = true;

  tbody.innerHTML = list.map(p => {
    const pid = p._pid || makePaymentKey(p);
    const isTransferred = transferState.transferredIds.has(pid);
    const checked = transferState.selectedIds.has(pid);

    const partnerName = p.partnerName || '—';
    const note = p.remittanceInformation || '';
    const dateStr = p.dateOfPayment ? new Date(p.dateOfPayment).toLocaleDateString('sk-SK') : '—';
    const sumRaw = p.sumOfPayment != null ? Number(p.sumOfPayment) : null;
    const sumFormatted = sumRaw != null ? sumRaw.toFixed(2) : '—';
    const currency = p.currency || 'EUR';
    const sumClass = sumRaw == null ? '' : (sumRaw >= 0 ? 'sum-positive' : 'sum-negative');
    const vsText = p.variableSymbol && p.variableSymbol !== '' ? p.variableSymbol
      : (p.paymentReference && p.paymentReference !== '' ? p.paymentReference : '—');

    const transferredIcon = isTransferred
      ? `<span class="icon-transferred" title="Prevedené na cieľový účet">&#10003;</span>`
      : `<span class="icon-not-transferred" title="Ešte neprevedené">&#8212;</span>`;
    const rowClass = isTransferred ? 'row-transferred' : (checked ? 'selected' : '');

    return `
      <tr class="${rowClass}" data-id="${escapeHtml(pid)}">
        <td class="col-check"><input type="checkbox" class="transfer-check" data-id="${escapeHtml(pid)}" ${checked ? 'checked' : ''} ${isTransferred ? 'disabled' : ''}></td>
        <td class="tr-col-date">
          <span class="cell-l1">${escapeHtml(dateStr)}</span>
        </td>
        <td class="tr-col-partner" title="${escapeHtml(partnerName)}">
          <span class="cell-l1 tr-partner-name">${escapeHtml(partnerName)}</span>
          ${note ? `<span class="cell-l2 cell-truncate tr-note">${escapeHtml(note)}</span>` : ''}
        </td>
        <td class="tr-col-vs">
          <span class="cell-l2">${escapeHtml(vsText)}</span>
        </td>
        <td class="tr-col-sum number">
          <span class="cell-l1 ${sumClass}">${escapeHtml(sumFormatted)} ${escapeHtml(currency)}</span>
        </td>
        <td class="tr-col-transferred">${transferredIcon}</td>
        <td class="col-action"><button type="button" class="btn btn-primary btn-sm btn-transfer-one" data-id="${escapeHtml(pid)}" ${isTransferred ? 'disabled title="Už prevedené"' : ''}>Previesť</button></td>
      </tr>`;
  }).join('');

  tbody.querySelectorAll('.btn-transfer-one').forEach(btn => {
    btn.addEventListener('click', e => {
      e.stopPropagation();
      const pid = btn.dataset.id;
      const payment = transferState.payments.find(p => (p._pid || makePaymentKey(p)) === pid);
      if (payment) transferSinglePayment(payment);
    });
  });

  tbody.querySelectorAll('.transfer-check').forEach(cb => {
    cb.addEventListener('change', () => {
      const pid = cb.dataset.id;
      if (cb.checked) transferState.selectedIds.add(pid);
      else transferState.selectedIds.delete(pid);
      const tr = cb.closest('tr');
      if (tr) {
        if (cb.checked) tr.classList.add('selected');
        else tr.classList.remove('selected');
      }
      updateTransferSelectedCount();
    });
  });

  tbody.querySelectorAll('tr').forEach(tr => {
    tr.addEventListener('click', ev => {
      if (ev.target.tagName === 'INPUT' || ev.target.closest('button')) return;
      const pid = tr.dataset.id;
      const cb = tr.querySelector('.transfer-check');
      if (!cb || cb.disabled) return;
      cb.checked = !cb.checked;
      if (cb.checked) transferState.selectedIds.add(pid);
      else transferState.selectedIds.delete(pid);
      if (cb.checked) tr.classList.add('selected');
      else tr.classList.remove('selected');
      updateTransferSelectedCount();
    });
  });

  const checkAll = document.getElementById('transfer-check-all');
  const selectable = list.filter(p => !transferState.transferredIds.has(p._pid || makePaymentKey(p)));
  checkAll.checked = selectable.length > 0 && selectable.every(p => transferState.selectedIds.has(p._pid || makePaymentKey(p)));
  checkAll.indeterminate = transferState.selectedIds.size > 0 && !checkAll.checked;
  updateTransferSelectedCount();
}

function updateTransferSelectedCount() {
  const n = transferState.selectedIds.size;
  document.getElementById('transfer-selected-count').textContent = n ? `Vybraných: ${n}` : '';
  document.getElementById('btn-transfer-selected').disabled = n === 0 || !document.getElementById('transfer-dst-account').value;
}

function showTransferResult(msg, type = 'success') {
  const el = document.getElementById('transfer-result');
  if (!el) return;
  el.innerHTML = msg;
  el.hidden = false;
  el.className = 'result-box ' + type;
}

async function transferSinglePayment(payment) {
  const dstId = document.getElementById('transfer-dst-account').value;
  if (!dstId) {
    showTransferResult('Vyberte cieľový účet.', 'error');
    return;
  }
  const pid = payment._pid || makePaymentKey(payment);
  if (transferState.transferredIds.has(pid)) {
    showTransferResult('Platba už bola prevedená na cieľový účet.', 'warning');
    return;
  }

  const btn = document.querySelector(`.btn-transfer-one[data-id="${CSS.escape(pid)}"]`);
  const originalText = btn?.textContent ?? 'Previesť';
  if (btn) {
    btn.disabled = true;
    btn.textContent = 'Spracováva sa…';
  }
  document.getElementById('transfer-result').hidden = true;

  const paymentItem = {
    dateOfPayment: payment.dateOfPayment,
    sumOfPayment: -(Number(payment.sumOfPayment) || 0),
    originalSumOfPayment: -(Number(payment.originalSumOfPayment || payment.sumOfPayment) || 0),
    originalCurrency: payment.currency || payment.originalCurrency || 'EUR',
    variableSymbol: payment.variableSymbol || '',
    partnerName: (payment.partnerName || '').slice(0, 255) || undefined,
    accountId: Number(dstId),
    externalId: pid,
    note: 'Prevod medzi vlastnými účtami',
  };
  if (payment.paymentReference) paymentItem.paymentReference = payment.paymentReference;

  try {
    const res = await apiCallTransfer('/api/payments/batch', { method: 'POST', body: { data: [paymentItem] } });
    const requestId = res?.requestId || '';
    transferState.transferredIds.add(pid);
    transferState.selectedIds.delete(pid);
    renderTransferPayments();
    showTransferResult(`Prevod prebehol (202). RequestId: ${requestId}.`, 'success');
  } catch (e) {
    if (btn) {
      btn.disabled = false;
      btn.textContent = originalText;
    }
    if (e.status === 401) showLogin();
    else if (e.status === 408) showTransferResult('Vypršal časový limit (408). Skúste znova.', 'warning');
    else if (e.status === 409) showTransferResult('Duplicitná požiadavka (409). Počkajte cca 120 s a skúste znova.', 'warning');
    else if (e.status === 429) showTransferResult(`Príliš veľa požiadaviek (429). Počkajte ${e.retryAfter || 60} s.`, 'warning');
    else if (e.status === 400 && e.data?.errors) {
      const list = e.data.errors.map(x => `${x.propertyPath || '?'}: ${x.errorMessage || ''}`).join('<br>');
      showTransferResult('Chyby:<br>' + list, 'error');
    } else {
      showTransferResult('Chyba: ' + (e.message || e.status), 'error');
    }
  }
}

async function transferSelectedPayments() {
  const dstId = document.getElementById('transfer-dst-account').value;
  if (!dstId) {
    showTransferResult('Vyberte cieľový účet.', 'error');
    return;
  }
  const toTransfer = transferState.filteredPayments.filter(p => {
    const pid = p._pid || makePaymentKey(p);
    return transferState.selectedIds.has(pid) && !transferState.transferredIds.has(pid);
  });
  if (toTransfer.length === 0) {
    showTransferResult('Nevybrali ste žiadnu platbu na prevod.', 'error');
    return;
  }

  const btn = document.getElementById('btn-transfer-selected');
  btn.disabled = true;
  document.getElementById('transfer-result').hidden = true;

  let successCount = 0;
  let errorCount = 0;
  const errors = [];

  for (const payment of toTransfer) {
    const pid = payment._pid || makePaymentKey(payment);
    if (transferState.transferredIds.has(pid)) { successCount++; continue; }

    const paymentItem = {
      dateOfPayment: payment.dateOfPayment,
      sumOfPayment: -(Number(payment.sumOfPayment) || 0),
      originalSumOfPayment: -(Number(payment.originalSumOfPayment || payment.sumOfPayment) || 0),
      originalCurrency: payment.currency || payment.originalCurrency || 'EUR',
      variableSymbol: payment.variableSymbol || '',
      partnerName: (payment.partnerName || '').slice(0, 255) || undefined,
      accountId: Number(dstId),
      externalId: pid,
      note: 'Prevod medzi vlastnými účtami',
    };
    if (payment.paymentReference) paymentItem.paymentReference = payment.paymentReference;

    try {
      await apiCallTransfer('/api/payments/batch', { method: 'POST', body: { data: [paymentItem] } });
      transferState.transferredIds.add(pid);
      transferState.selectedIds.delete(pid);
      successCount++;
    } catch (e) {
      errorCount++;
      errors.push(`Platba ${pid}: ${e.message || e.status}`);
      if (e.status === 401) { showLogin(); return; }
    }
  }

  renderTransferPayments();
  if (errorCount === 0) {
    showTransferResult(`Úspešne prevedených ${successCount} platíeb.`, 'success');
  } else {
    showTransferResult(
      `Prevedených ${successCount}, neúspešných ${errorCount}.<br>` + errors.map(escapeHtml).join('<br>'),
      errorCount === toTransfer.length ? 'error' : 'warning'
    );
  }
  btn.disabled = transferState.selectedIds.size === 0;
}

function bindEvents() {
  document.querySelectorAll('.env-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      setApiBase(btn.dataset.url);
    });
  });

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
  ['filter-date-from', 'filter-date-to'].forEach((id) => {
    const dateInput = document.getElementById(id);
    if (!dateInput) return;
    dateInput.addEventListener('change', () => {
      saveSettings();
      loadInvoices(0);
    });
  });

  document.getElementById('account')?.addEventListener('change', () => { updateSelectedCount(); saveSettings(); });

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

  // Module picker
  document.getElementById('btn-module-invoices')?.addEventListener('click', showMain);
  document.getElementById('btn-module-transfer')?.addEventListener('click', showTransfer);
  document.getElementById('btn-module-logout')?.addEventListener('click', () => {
    state.token = '';
    localStorage.removeItem(STORAGE_TOKEN);
    showLogin();
  });

  // Back buttons
  document.getElementById('btn-back-invoices')?.addEventListener('click', showModulePicker);
  document.getElementById('btn-back-transfer')?.addEventListener('click', showModulePicker);

  // Transfer logout
  document.getElementById('btn-transfer-logout')?.addEventListener('click', () => {
    state.token = '';
    localStorage.removeItem(STORAGE_TOKEN);
    showLogin();
  });

  // Transfer module actions
  document.getElementById('btn-load-transfer')?.addEventListener('click', loadTransferPayments);
  document.getElementById('btn-transfer-selected')?.addEventListener('click', transferSelectedPayments);

  document.getElementById('transfer-check-all')?.addEventListener('change', function () {
    const selectable = transferState.filteredPayments.filter(p => !transferState.transferredIds.has(p._pid || makePaymentKey(p)));
    if (this.checked) {
      selectable.forEach(p => transferState.selectedIds.add(p._pid || makePaymentKey(p)));
    } else {
      selectable.forEach(p => transferState.selectedIds.delete(p._pid || makePaymentKey(p)));
    }
    renderTransferPayments();
  });

  document.getElementById('transfer-partner-filter')?.addEventListener('input', applyTransferFilter);
  document.getElementById('transfer-status-filter')?.querySelectorAll('.toggle-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#transfer-status-filter .toggle-btn').forEach(b => b.classList.remove('toggle-btn-active'));
      btn.classList.add('toggle-btn-active');
      applyTransferFilter();
    });
  });

  document.getElementById('transfer-src-account')?.addEventListener('change', saveTransferSettings);
  document.getElementById('transfer-dst-account')?.addEventListener('change', () => {
    updateTransferSelectedCount();
    saveTransferSettings();
  });
  ['transfer-date-from', 'transfer-date-to'].forEach((id) => {
    document.getElementById(id)?.addEventListener('change', () => {
      saveTransferSettings();
      loadTransferPayments();
    });
  });

  document.getElementById('toggle-transfer-api-log')?.addEventListener('click', () => {
    const panel = document.getElementById('panel-transfer-api-log');
    const btn = document.getElementById('toggle-transfer-api-log');
    if (!panel || !btn) return;
    panel.classList.toggle('expanded');
    btn.setAttribute('aria-expanded', panel.classList.contains('expanded'));
  });
  document.getElementById('btn-clear-transfer-api-log')?.addEventListener('click', () => {
    const el = document.getElementById('transfer-api-log');
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
