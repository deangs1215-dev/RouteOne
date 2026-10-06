// Sanity check on SYSPRO contract prices, run after every contract_pricing sync.
//
// Why it exists: on 2026-10-06 RouteOne was holding contract prices for ~210
// customers when SYSPRO had them for ~1,500. Nothing flagged it - orders were
// simply priced at the price-code price until a rep noticed (ORD-00272). Two
// independent SYSPRO views carry contract prices (the big customer_pricing view
// and the small contract_pricing view), so the cheapest reliable alarm is to
// compare them with each other and with the previous run.
//
//   1. main view vs contract view - the big view, read twice a day, must hold
//      roughly the same number of in-window contract prices as the contract
//      view. A big shortfall is exactly the 2026-10-06 failure.
//   2. this run vs the previous run - contracts do not vanish by the thousand
//      between two syncs; a sudden drop means the source view is broken.
//
// Results go to three places: settings (shown on the Integration page), the
// sync run's error text (so the daily digest email carries it) and, when the
// problem is new, a direct email to the sync digest recipients.
import { dbx, getTodayISO } from '../db.js';
import { getSetting, setSetting } from '../dbh.js';
import { sendEmail } from './email.js';

// A source Date from SQL Server, or an already-ISO string, as 'YYYY-MM-DD'.
const isoDay = (v) => {
  if (v == null || v === '') return null;
  if (v instanceof Date) return v.toISOString().split('T')[0];
  return String(v).slice(0, 10);
};

const inWindow = (start, end, today) => (!start || start <= today) && (!end || end >= today);

// How many contract / buying-group prices a set of source rows would apply today.
export function countLivePrices(rows, today = getTodayISO()) {
  let contract = 0;
  let buyingGroup = 0;
  for (const r of rows) {
    if (r.contract_price != null && inWindow(isoDay(r.contract_start_date), isoDay(r.contract_end_date), today)) contract += 1;
    if (r.buying_group_price != null && inWindow(isoDay(r.buying_group_start_date), isoDay(r.buying_group_end_date), today)) buyingGroup += 1;
  }
  return { contract, buyingGroup };
}

// Called by the customer_pricing sync with the rows it just read, so the check
// can later compare what the big view held against the contract view.
export async function noteMainViewContracts(rows) {
  const counts = countLivePrices(rows);
  await setSetting('contract_check_mainview', JSON.stringify({ at: new Date().toISOString(), ...counts }));
  return counts;
}

const readJson = async (key) => {
  try { return JSON.parse(await getSetting(key, '') || 'null'); } catch { return null; }
};

// What RouteOne holds right now (after the contract sync wrote it).
async function storedLivePrices(today) {
  const row = await dbx.prepare(`
    SELECT
      SUM(CASE WHEN contract_price IS NOT NULL AND (contract_start_date IS NULL OR contract_start_date <= ?)
                AND (contract_end_date IS NULL OR contract_end_date >= ?) THEN 1 ELSE 0 END) AS contract,
      SUM(CASE WHEN buying_group_price IS NOT NULL AND (buying_group_start_date IS NULL OR buying_group_start_date <= ?)
                AND (buying_group_end_date IS NULL OR buying_group_end_date >= ?) THEN 1 ELSE 0 END) AS buying_group
    FROM syspro_customer_pricing
  `).get(today, today, today, today);
  return { contract: Number(row?.contract) || 0, buyingGroup: Number(row?.buying_group) || 0 };
}

const MAIN_VIEW_MAX_AGE_MS = 36 * 3600 * 1000;
const fmt = (n) => Number(n).toLocaleString('en-ZA');

// Returns the list of warnings (empty = healthy) and records the outcome.
// `thresholds` exist so tests can use small numbers.
export async function checkContractPricing({ today = getTodayISO(), minLines = 100, now = Date.now() } = {}) {
  const warnings = [];
  const stored = await storedLivePrices(today);
  const previous = await readJson('contract_check_state');
  const mainView = await readJson('contract_check_mainview');

  // 1. The big view must hold about as many contracts as the contract view. 20%
  // slack covers contracts created/edited between the two reads.
  if (mainView && stored.contract >= minLines && now - new Date(mainView.at).getTime() < MAIN_VIEW_MAX_AGE_MS
      && mainView.contract < stored.contract * 0.8) {
    warnings.push(`The main pricing view returned ${fmt(mainView.contract)} contract prices but the contract view has ${fmt(stored.contract)}. ` +
      'Prices from the main view alone would be wrong for the difference - the contract sync is covering it, but the main view needs looking at.');
  }
  if (mainView && stored.buyingGroup >= minLines && now - new Date(mainView.at).getTime() < MAIN_VIEW_MAX_AGE_MS
      && mainView.buyingGroup < stored.buyingGroup * 0.8) {
    warnings.push(`The main pricing view returned ${fmt(mainView.buyingGroup)} buying-group prices but the contract view has ${fmt(stored.buyingGroup)}.`);
  }

  // 2. A sudden collapse since the previous run.
  if (previous && previous.contract >= minLines && stored.contract < previous.contract * 0.75) {
    warnings.push(`Contract prices dropped from ${fmt(previous.contract)} to ${fmt(stored.contract)} since the last check - ` +
      'the contract view may be returning incomplete data.');
  }
  if (previous && previous.buyingGroup >= minLines && stored.buyingGroup < previous.buyingGroup * 0.75) {
    warnings.push(`Buying-group prices dropped from ${fmt(previous.buyingGroup)} to ${fmt(stored.buyingGroup)} since the last check.`);
  }

  const summary = `${fmt(stored.contract)} contract and ${fmt(stored.buyingGroup)} buying-group prices in force`;
  await setSetting('contract_check_state', JSON.stringify({ at: new Date(now).toISOString(), ...stored }));
  await setSetting('contract_check_at', new Date(now).toISOString());
  await setSetting('contract_check_result', warnings.length ? `WARNING: ${warnings.join(' ')}` : `OK - ${summary}`);
  if (warnings.length) await alertOnce(warnings, now);
  return warnings;
}

// Email the sync digest recipients, but only when the problem is new or a day
// old - the check runs every 15 minutes and must not send 96 identical emails.
async function alertOnce(warnings, now) {
  try {
    const key = warnings.join('|');
    const last = await readJson('contract_check_last_alert');
    if (last && last.key === key && now - new Date(last.at).getTime() < 24 * 3600 * 1000) return;
    const to = (await getSetting('sync_digest_emails', '')).split(/[,;]/).map((e) => e.trim()).filter(Boolean);
    await setSetting('contract_check_last_alert', JSON.stringify({ at: new Date(now).toISOString(), key }));
    for (const addr of to) {
      await sendEmail({
        kind: 'sync_alert', ref_id: 0, to_addr: addr, cc_addr: null,
        subject: 'RouteOne: contract pricing check needs attention',
        body_html: `<p>The contract pricing check found a problem:</p><ul>${warnings.map((w) => `<li>${w.replace(/</g, '&lt;')}</li>`).join('')}</ul>` +
          '<p>Reps may be quoted prices that differ from SYSPRO until this is resolved. See Settings &rarr; Integration for the latest status.</p>'
      });
    }
  } catch (e) {
    // An alert that cannot be sent must never fail the sync that raised it.
    console.error('[contract-check] alert failed:', e.message);
  }
}
