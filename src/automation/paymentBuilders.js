/**
 * Payloady platieb pre automatizácie. Zrkadlia ručné tlačidlá v public/app.js
 * (paySingleInvoice, transferSinglePayment) – výsledok v KROS má byť rovnaký,
 * či úhradu spraví človek alebo automat. Pri zmene logiky tam uprav aj tu.
 */

export function roundCurrency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 100) / 100;
}

/** VS dlhší ako 10 znakov alebo s nečíselnými znakmi ide do referencie platby. */
export function getVariableSymbolAndReference(doc) {
  const raw = (doc.variableSymbol ?? '').toString().trim();
  if (!raw) return { variableSymbol: '', reference: undefined };
  if (raw.length > 10 || /[^0-9]/.test(raw)) return { variableSymbol: '', reference: raw };
  return { variableSymbol: raw, reference: undefined };
}

/** Výdavok → tvar dokladu ako faktúra (odchádzajúca platba = záporná suma). VS len z variableSymbol, ako pri faktúrach. */
export function normalizeExpense(exp) {
  const docPrices = exp?.prices?.documentPrices || {};
  const forPayment = Number(docPrices.sumForPayment ?? docPrices.totalPriceInclVat ?? 0);
  const paid = Number(docPrices.sumOfPayments ?? 0);
  return {
    ...exp,
    isExpense: true,
    variableSymbol: exp.variableSymbol || '',
    sumForPayment: -forPayment,
    sumOfPayments: -paid,
  };
}

export function getSumForPayment(doc) {
  const forPayment = Number(doc.sumForPayment ?? doc.prices?.documentPrices?.totalPriceInclVat ?? 0);
  const paid = Number(doc.sumOfPayments ?? 0);
  return roundCurrency(forPayment - paid);
}

export function getSumForPaymentLegislative(doc) {
  const docSum = getSumForPayment(doc);
  const docTotal = Number(doc.prices?.documentPrices?.totalPriceInclVat ?? 0);
  const legTotal = Number(doc.prices?.legislativePrices?.totalPriceInclVat ?? 0);
  if (docTotal <= 0 || !(legTotal > 0)) return roundCurrency(docSum);
  return roundCurrency((docSum / docTotal) * legTotal);
}

export function docPartnerName(doc) {
  return String(doc?.partner?.address?.businessName || '');
}

export const ymd = (value) => String(value ?? '').slice(0, 10);

/** Úhrada dokladu (faktúra alebo normalizovaný výdavok), dátum úhrady = dátum vystavenia. */
export function buildDocumentPayment(doc, { accountId, externalId }) {
  const { variableSymbol, reference } = getVariableSymbolAndReference(doc);
  const partnerName = docPartnerName(doc).slice(0, 255);
  const item = {
    dateOfPayment: ymd(doc.issueDate) || new Date().toISOString().slice(0, 10),
    sumOfPayment: getSumForPaymentLegislative(doc),
    originalSumOfPayment: getSumForPayment(doc),
    originalCurrency: doc.prices?.currency || 'EUR',
    variableSymbol,
    partnerName: partnerName || undefined,
    accountId: Number(accountId),
    externalId,
  };
  if (reference !== undefined) item.paymentReference = reference;
  return item;
}

export function rawPaymentId(p) {
  const raw = p?.id ?? p?.paymentId ?? p?.paymentID ?? null;
  return raw == null || raw === '' ? null : String(raw);
}

/** Rovnaký kľúč ako ručný prevod (makePaymentIdKey v app.js) → ručný modul aj automat vidia to isté. */
export function transferKey(payment, srcAccountId) {
  const id = rawPaymentId(payment);
  return id ? `PID-${srcAccountId}-${id}` : null;
}

export function buildTransferPayment(payment, { targetAccountId, externalId }) {
  const item = {
    dateOfPayment: payment.dateOfPayment,
    sumOfPayment: -(Number(payment.sumOfPayment) || 0),
    originalSumOfPayment: -(Number(payment.originalSumOfPayment || payment.sumOfPayment) || 0),
    originalCurrency: payment.currency || payment.originalCurrency || 'EUR',
    variableSymbol: payment.variableSymbol || '',
    remittanceInformation: (payment.remittanceInformation || '').slice(0, 140) || undefined,
    partnerName: (payment.partnerName || '').slice(0, 255) || undefined,
    accountId: Number(targetAccountId),
    externalId,
    note: 'Prevod medzi vlastnými účtami',
    isWithoutDocument: true,
  };
  if (payment.paymentReference) item.paymentReference = payment.paymentReference;
  return item;
}

export function partnerMatches(name, partnerText) {
  const needle = String(partnerText || '').trim().toLowerCase();
  if (!needle) return true;
  return String(name || '').toLowerCase().includes(needle);
}
