/**
 * Automatizácia úhrad a prevodov – panel v module „Neuhradené faktúry“ aj „Prevod medzi účtami“.
 * Pravidlá drží server (/api/automations) a vyhodnocuje ich sám raz za hodinu.
 * Používa globálne funkcie z app.js: apiCall, escapeHtml, getActiveCompanyConnection, showToast,
 * formatApiError, apiErrorType.
 */
(() => {
  const RULE_STATUS = {
    ok: { label: 'OK', cls: 'ok' },
    warning: { label: 'Niektoré položky zlyhali', cls: 'warning' },
    error: { label: 'Chyba', cls: 'error' },
    connection_invalid: { label: 'Neplatné prepojenie s KROS', cls: 'error' },
  };
  const ITEM_STATUS = {
    pending: { label: 'Spracúva sa', cls: 'muted' },
    sent: { label: 'Odoslané', cls: 'ok' },
    confirmed: { label: 'Potvrdené KROS', cls: 'ok' },
    failed: { label: 'Chyba', cls: 'error' },
    rejected: { label: 'Odmietnuté KROS', cls: 'error' },
    skipped_exists: { label: 'Už bolo v KROS', cls: 'muted' },
  };
  const DOC_TYPES = { all: 'Faktúry aj výdavky', invoices: 'Iba faktúry', expenses: 'Iba výdavky' };

  const accountsCache = new Map();
  const panelState = new Map();

  const logIdFor = (kind) => (kind === 'transfer' ? 'transfer-api-log' : 'api-log');
  const today = () => new Date().toISOString().slice(0, 10);

  function fmtDate(ymd) {
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(ymd || ''));
    return m ? `${Number(m[3])}. ${Number(m[2])}. ${m[1]}` : '—';
  }

  function fmtDateTime(iso) {
    if (!iso) return '—';
    return new Date(iso).toLocaleString('sk-SK', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
  }

  function fmtSum(n, currency) {
    if (n == null) return '';
    return `${Number(n).toFixed(2)} ${currency || 'EUR'}`;
  }

  async function loadAccounts(connId, kind) {
    if (accountsCache.has(connId)) return accountsCache.get(connId);
    const res = await apiCall('/api/payments/accounts', { method: 'GET' }, logIdFor(kind));
    const list = res?.data || [];
    accountsCache.set(connId, list);
    return list;
  }

  function accountName(list, id) {
    const a = list.find((x) => String(x.id) === String(id));
    return a ? (a.name || a.iban || `Účet ${a.id}`) : `účet #${id}`;
  }

  function accountOptions(list, selected) {
    return '<option value="">— vyberte účet —</option>' + list.map((a) =>
      `<option value="${escapeHtml(String(a.id))}" title="${escapeHtml(a.iban || '')}" ${String(a.id) === String(selected ?? '') ? 'selected' : ''}>`
      + `${escapeHtml(formatAccountLabel(a))}</option>`,
    ).join('');
  }

  /** Hlásenie v paneli (desktop) + toast (mobil). `html` musí byť už escapované. */
  function notify(panel, html, type = 'success') {
    const el = panel.querySelector('.automation-result');
    if (el) {
      el.className = `result-box ${type} automation-result`;
      el.innerHTML = html;
      el.hidden = false;
    }
    showToast(html, type);
  }

  function summaryText(summary) {
    if (!summary) return '';
    const parts = [];
    if (summary.sent) parts.push(`odoslané ${summary.sent}`);
    if (summary.skippedExisting) parts.push(`už v KROS ${summary.skippedExisting}`);
    if (summary.failed) parts.push(`chyby ${summary.failed}`);
    if (!parts.length) parts.push('nič nové');
    return parts.join(', ');
  }

  function renderRule(rule, ctx) {
    const partner = rule.partnerText
      ? `Partner obsahuje „${escapeHtml(rule.partnerText)}“`
      : 'Všetci partneri';
    const meta = rule.kind === 'transfer'
      ? `${escapeHtml(accountName(ctx.accounts, rule.accountId))} → ${escapeHtml(accountName(ctx.accounts, rule.targetAccountId))}`
      : `${escapeHtml(DOC_TYPES[rule.docTypes] || '')} · z účtu ${escapeHtml(accountName(ctx.accounts, rule.accountId))}`;
    const st = RULE_STATUS[rule.lastStatus];
    const status = rule.lastRunAt
      ? `<span class="ar-status ar-status--${st?.cls || 'muted'}">Naposledy ${escapeHtml(fmtDateTime(rule.lastRunAt))} – `
        + `${escapeHtml(st?.label || rule.lastStatus || '')}${rule.lastStatus !== 'error' && rule.lastStatus !== 'connection_invalid' ? ' · ' + escapeHtml(summaryText(rule.lastSummary)) : ''}</span>`
      : `<span class="ar-status ar-status--muted">${rule.enabled ? 'Zatiaľ nebežalo – spustí sa do hodiny' : 'Vypnuté'}</span>`;
    const error = rule.lastError && rule.lastStatus !== 'ok'
      ? `<span class="ar-error">${escapeHtml(rule.lastError)}</span>` : '';
    const itemsOpen = ctx.openItems.has(rule.id);
    return `
      <div class="automation-rule ${rule.enabled ? '' : 'is-disabled'}" data-id="${escapeHtml(rule.id)}">
        <div class="ar-head">
          <label class="ar-switch" title="${rule.enabled ? 'Vypnúť' : 'Zapnúť'} pravidlo">
            <input type="checkbox" class="ar-enabled" ${rule.enabled ? 'checked' : ''} aria-label="Pravidlo zapnuté">
            <span class="ar-switch-track"></span>
          </label>
          <div class="ar-text">
            <span class="ar-title">${partner}</span>
            <span class="ar-meta">${meta} · od ${escapeHtml(fmtDate(rule.startDate))}</span>
            ${status}
            ${error}
          </div>
        </div>
        <div class="ar-buttons">
          <button type="button" class="btn btn-secondary btn-sm ar-run">Spustiť teraz</button>
          <button type="button" class="btn btn-secondary btn-sm ar-items-toggle" aria-expanded="${itemsOpen}">${itemsOpen ? 'Skryť históriu' : 'História'}</button>
          <button type="button" class="btn btn-secondary btn-sm ar-edit">Upraviť</button>
          <button type="button" class="btn btn-secondary btn-sm ar-delete">Zmazať</button>
        </div>
        <div class="ar-items" ${itemsOpen ? '' : 'hidden'}></div>
      </div>`;
  }

  function renderItems(items) {
    if (!items.length) return '<p class="muted ar-items-empty">Automat zatiaľ nič neodoslal.</p>';
    return `<ul class="ar-item-list">${items.map((i) => {
      const st = ITEM_STATUS[i.status] || { label: i.status, cls: 'muted' };
      return `<li class="ar-item">
        <span class="ar-item-label">${escapeHtml(i.label || i.itemKey)}</span>
        <span class="ar-item-sum">${escapeHtml(fmtSum(i.amount, i.currency))}</span>
        <span class="ar-item-status ar-status--${st.cls}" title="${escapeHtml(i.error || '')}">${escapeHtml(st.label)}</span>
        <span class="ar-item-date muted">${escapeHtml(fmtDateTime(i.createdAt))}</span>
        ${i.error && (i.status === 'failed' || i.status === 'rejected') ? `<span class="ar-item-error">${escapeHtml(i.error)}</span>` : ''}
      </li>`;
    }).join('')}</ul>`;
  }

  function renderForm(ctx, rule) {
    const r = rule || { partnerText: '', docTypes: 'all', accountId: '', targetAccountId: '', startDate: today(), enabled: true };
    const isTransfer = ctx.kind === 'transfer';
    const id = (name) => `${ctx.panelId}-${name}`;
    const field = (name, label, control, cls = '') =>
      `<div class="filter-field ${cls}"><label class="sf-label" for="${id(name)}">${label}</label>${control}</div>`;
    const accountSelect = (name, value) =>
      `<select id="${id(name)}" name="${name}" required>${accountOptions(ctx.accounts, value)}</select>`;
    const fields = isTransfer
      ? [
        field('startDate', 'Platby od', `<input type="date" id="${id('startDate')}" name="startDate" value="${escapeHtml(r.startDate)}" required>`),
        field('accountId', 'Zdrojový účet', accountSelect('accountId', r.accountId)),
        field('targetAccountId', 'Cieľový účet', accountSelect('targetAccountId', r.targetAccountId)),
      ]
      : [
        field('startDate', 'Vystavené od', `<input type="date" id="${id('startDate')}" name="startDate" value="${escapeHtml(r.startDate)}" required>`),
        field('accountId', 'Účet na úhradu', accountSelect('accountId', r.accountId)),
        field('docTypes', 'Typ dokladov', `<select id="${id('docTypes')}" name="docTypes">${Object.entries(DOC_TYPES)
          .map(([v, l]) => `<option value="${v}" ${r.docTypes === v ? 'selected' : ''}>${l}</option>`).join('')}</select>`),
      ];
    return `
      <header class="ad-head">
        <div>
          <h3 class="ad-title">${rule ? 'Upraviť pravidlo' : 'Nové pravidlo'}</h3>
          <p class="ad-sub">${isTransfer ? 'Prevod platieb medzi vlastnými účtami' : 'Automatická úhrada dokladov'}</p>
        </div>
        <button type="button" class="ad-close automation-cancel" aria-label="Zavrieť">&times;</button>
      </header>
      <div class="ad-body">
        ${field('partnerText', 'Názov partnera obsahuje',
          `<input type="text" id="${id('partnerText')}" name="partnerText" value="${escapeHtml(r.partnerText)}" placeholder="prázdne = všetci" autocomplete="off" maxlength="200">`)}
        ${fields.join('')}
        <div class="result-box automation-form-error ad-span-2" hidden></div>
      </div>
      <footer class="ad-foot">
        <label class="ar-switch-label">
          <span class="ar-switch">
            <input type="checkbox" name="enabled" ${r.enabled ? 'checked' : ''}>
            <span class="ar-switch-track"></span>
          </span>
          Zapnuté
        </label>
        <div class="ad-buttons">
          <button type="button" class="btn btn-secondary btn-sm automation-cancel">Zrušiť</button>
          <button type="submit" class="btn btn-primary btn-sm">${rule ? 'Uložiť' : 'Vytvoriť pravidlo'}</button>
        </div>
      </footer>`;
  }

  function updateSummaryChip(panel, ctx) {
    const chip = panel.querySelector('.automation-summary');
    if (!chip) return;
    const active = ctx.rules.filter((r) => r.enabled).length;
    const failing = ctx.rules.filter((r) => r.enabled && ['error', 'connection_invalid', 'warning'].includes(r.lastStatus)).length;
    chip.textContent = ctx.rules.length === 0
      ? ''
      : `${active} z ${ctx.rules.length} aktívnych${failing ? ` · ${failing} s chybou` : ''}`;
    chip.classList.toggle('automation-summary--warn', failing > 0);
  }

  function render(panel) {
    const ctx = panelState.get(panel.id);
    const list = panel.querySelector('.automation-list');
    if (ctx.message) {
      list.innerHTML = `<p class="muted">${escapeHtml(ctx.message)}</p>`;
    } else if (ctx.rules.length === 0) {
      list.innerHTML = '<p class="muted automation-empty">Zatiaľ žiadne pravidlá.</p>';
    } else {
      list.innerHTML = ctx.rules.map((r) => renderRule(r, ctx)).join('');
      for (const id of ctx.openItems) loadItems(panel, id);
    }
    panel.querySelector('.automation-add').hidden = Boolean(ctx.message);
    updateSummaryChip(panel, ctx);
  }

  async function loadItems(panel, ruleId) {
    const ctx = panelState.get(panel.id);
    const el = panel.querySelector(`.automation-rule[data-id="${CSS.escape(ruleId)}"] .ar-items`);
    if (!el) return;
    el.innerHTML = '<p class="muted">Načítavam…</p>';
    try {
      const items = await apiCall(`/api/automations/${encodeURIComponent(ruleId)}/items?limit=30`, { method: 'GET' }, logIdFor(ctx.kind));
      el.innerHTML = renderItems(items || []);
    } catch (e) {
      el.innerHTML = `<div class="result-box ${apiErrorType(e)}">${formatApiError(e, 'Históriu sa nepodarilo načítať')}</div>`;
    }
  }

  function openForm(panel, rule) {
    const ctx = panelState.get(panel.id);
    ctx.editing = rule ? rule.id : 'new';
    const dialog = panel.querySelector('.automation-dialog');
    dialog.querySelector('.automation-form').innerHTML = renderForm(ctx, rule);
    dialog.showModal();
    dialog.querySelector('input[name="partnerText"]')?.focus();
  }

  function closeForm(panel) {
    const dialog = panel.querySelector('.automation-dialog');
    if (dialog.open) dialog.close();
  }

  async function submitForm(panel) {
    const ctx = panelState.get(panel.id);
    const form = panel.querySelector('.automation-form');
    const errEl = form.querySelector('.automation-form-error');
    const fd = new FormData(form);
    const body = {
      partnerText: String(fd.get('partnerText') || '').trim(),
      accountId: fd.get('accountId'),
      startDate: fd.get('startDate') || today(),
      enabled: fd.get('enabled') === 'on',
    };
    if (ctx.kind === 'transfer') body.targetAccountId = fd.get('targetAccountId');
    else body.docTypes = fd.get('docTypes') || 'all';
    const submitBtn = form.querySelector('button[type="submit"]');
    submitBtn.disabled = true;
    errEl.hidden = true;
    try {
      if (ctx.editing === 'new') {
        await apiCall('/api/automations', {
          method: 'POST', body: { ...body, kind: ctx.kind, connectionId: ctx.connectionId },
        }, logIdFor(ctx.kind));
        notify(panel, 'Pravidlo vytvorené. Server ho spustí do hodiny – alebo kliknite „Spustiť teraz“.');
      } else {
        await apiCall(`/api/automations/${encodeURIComponent(ctx.editing)}`, { method: 'PUT', body }, logIdFor(ctx.kind));
        notify(panel, 'Pravidlo uložené.');
      }
      closeForm(panel);
      await refresh(panel);
    } catch (e) {
      errEl.className = `result-box ${apiErrorType(e)} automation-form-error`;
      errEl.innerHTML = e.data?.message ? escapeHtml(e.data.message) : formatApiError(e, 'Pravidlo sa nepodarilo uložiť');
      errEl.hidden = false;
    } finally {
      submitBtn.disabled = false;
    }
  }

  async function runNow(panel, rule, btn) {
    const ctx = panelState.get(panel.id);
    btn.disabled = true;
    btn.textContent = 'Beží…';
    try {
      const res = await apiCall(`/api/automations/${encodeURIComponent(rule.id)}/run`, { method: 'POST' }, logIdFor(ctx.kind));
      const st = RULE_STATUS[res.status];
      if (res.status === 'ok') notify(panel, `Hotovo: ${escapeHtml(summaryText(res.summary))}.`);
      else {
        const detail = res.error || res.rule?.lastError || '';
        notify(panel, `${escapeHtml(st?.label || res.status)}${detail ? ': ' + escapeHtml(detail) : ''}`, res.status === 'warning' ? 'warning' : 'error');
      }
      ctx.openItems.add(rule.id);
      await refresh(panel);
    } catch (e) {
      notify(panel, e.data?.message ? escapeHtml(e.data.message) : formatApiError(e, 'Automatizáciu sa nepodarilo spustiť'), apiErrorType(e));
      btn.disabled = false;
      btn.textContent = 'Spustiť teraz';
    }
  }

  async function setEnabled(panel, rule, enabled) {
    const ctx = panelState.get(panel.id);
    try {
      await apiCall(`/api/automations/${encodeURIComponent(rule.id)}`, { method: 'PUT', body: { enabled } }, logIdFor(ctx.kind));
      notify(panel, enabled ? 'Pravidlo zapnuté.' : 'Pravidlo vypnuté.');
    } catch (e) {
      notify(panel, formatApiError(e, 'Zmena sa neuložila'), apiErrorType(e));
    }
    await refresh(panel);
  }

  async function removeRule(panel, rule) {
    const ctx = panelState.get(panel.id);
    if (!window.confirm('Zmazať pravidlo? Už odoslané platby v KROS ostanú.')) return;
    try {
      await apiCall(`/api/automations/${encodeURIComponent(rule.id)}`, { method: 'DELETE' }, logIdFor(ctx.kind));
      ctx.openItems.delete(rule.id);
      notify(panel, 'Pravidlo zmazané.');
    } catch (e) {
      notify(panel, formatApiError(e, 'Pravidlo sa nepodarilo zmazať'), apiErrorType(e));
    }
    await refresh(panel);
  }

  async function refresh(panel) {
    const ctx = panelState.get(panel.id);
    const conn = getActiveCompanyConnection();
    if (!conn) {
      ctx.message = 'Najprv prepojte firmu s KROS.';
      ctx.rules = [];
      render(panel);
      return;
    }
    if (ctx.connectionId !== conn.id) {
      ctx.connectionId = conn.id;
      ctx.openItems.clear();
      closeForm(panel);
    }
    try {
      const [rules, accounts] = await Promise.all([
        apiCall(`/api/automations?connectionId=${encodeURIComponent(conn.id)}&kind=${ctx.kind}`, { method: 'GET' }, logIdFor(ctx.kind)),
        loadAccounts(conn.id, ctx.kind).catch(() => []),
      ]);
      ctx.rules = rules || [];
      ctx.accounts = accounts;
      ctx.message = null;
    } catch (e) {
      ctx.rules = [];
      ctx.message = 'Pravidlá sa nepodarilo načítať.';
    }
    render(panel);
  }

  function bind(panel) {
    const ctx = {
      panelId: panel.id, kind: panel.dataset.kind, rules: [], accounts: [], connectionId: null,
      editing: null, openItems: new Set(), message: null,
    };
    panelState.set(panel.id, ctx);

    panel.querySelector('.automation-toggle').addEventListener('click', (ev) => {
      const expanded = !panel.classList.contains('expanded');
      panel.classList.toggle('expanded', expanded);
      ev.currentTarget.setAttribute('aria-expanded', expanded ? 'true' : 'false');
      try { localStorage.setItem(`automation_open_${panel.id}`, expanded ? '1' : '0'); } catch (_) {}
    });
    try {
      if (localStorage.getItem(`automation_open_${panel.id}`) === '1') {
        panel.classList.add('expanded');
        panel.querySelector('.automation-toggle').setAttribute('aria-expanded', 'true');
      }
    } catch (_) {}

    panel.querySelector('.automation-add').addEventListener('click', async () => {
      if (!ctx.accounts.length && ctx.connectionId) {
        ctx.accounts = await loadAccounts(ctx.connectionId, ctx.kind).catch(() => []);
      }
      openForm(panel, null);
    });

    const form = panel.querySelector('.automation-form');
    form.addEventListener('submit', (ev) => {
      ev.preventDefault();
      submitForm(panel);
    });
    form.addEventListener('click', (ev) => {
      if (ev.target.closest('.automation-cancel')) closeForm(panel);
    });
    const dialog = panel.querySelector('.automation-dialog');
    dialog.addEventListener('close', () => {
      ctx.editing = null;
      form.innerHTML = '';
    });
    // Klik na pozadie (mimo okna) dialóg zavrie.
    dialog.addEventListener('click', (ev) => {
      if (ev.target === dialog) closeForm(panel);
    });

    panel.querySelector('.automation-list').addEventListener('click', (ev) => {
      const card = ev.target.closest('.automation-rule');
      if (!card) return;
      const rule = ctx.rules.find((r) => r.id === card.dataset.id);
      if (!rule) return;
      const btn = ev.target.closest('button');
      if (!btn) return;
      if (btn.classList.contains('ar-run')) runNow(panel, rule, btn);
      else if (btn.classList.contains('ar-edit')) openForm(panel, rule);
      else if (btn.classList.contains('ar-delete')) removeRule(panel, rule);
      else if (btn.classList.contains('ar-items-toggle')) {
        if (ctx.openItems.has(rule.id)) ctx.openItems.delete(rule.id);
        else ctx.openItems.add(rule.id);
        render(panel);
      }
    });
    panel.querySelector('.automation-list').addEventListener('change', (ev) => {
      if (!ev.target.classList.contains('ar-enabled')) return;
      const card = ev.target.closest('.automation-rule');
      const rule = ctx.rules.find((r) => r.id === card?.dataset.id);
      if (rule) setEnabled(panel, rule, ev.target.checked);
    });
  }

  document.querySelectorAll('.automation-panel').forEach(bind);
  // Ak app.js otvoril modul ešte pred načítaním tohto súboru.
  document.querySelectorAll('.automation-panel').forEach((panel) => {
    if (!panel.closest('section')?.classList.contains('hidden')) refresh(panel);
  });

  /** Volá app.js pri otvorení modulu a pri zmene firmy. */
  window.refreshAutomationPanel = (panelId) => {
    const panel = document.getElementById(panelId);
    if (panel && panelState.has(panelId)) refresh(panel);
  };
})();
