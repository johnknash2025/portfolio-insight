import { parseCsv, rowsToRecords, requireColumns } from "./csv.ts";

export interface Trade {
  date: string;
  symbol: string;
  side: "buy" | "sell";
  quantity: number;
  priceCents: number;
  currency: string;
}

export interface Snapshot {
  date: string;
  symbol: string;
  quantity: number;
  costCents: number | null;
  currency: string;
}

export interface DividendEvent {
  symbol: string;
  exDate: string;
  recordDate: string;
  payDate: string;
  perShareCents: number;
  currency: string;
}

export interface Position {
  symbol: string;
  quantity: number;
  costCents: number | null;
  avgCostCents: number;
  realizedCents: number;
  currency: string;
  lastActivityDate: string | null;
  tradeCount: number;
}

export interface AllocationEntry {
  symbol: string;
  quantity: number;
  quantityWeightPct: number | null;
  costCents: number | null;
  costWeightPct: number | null;
  currency: string;
  asOfDate: string | null;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isIsoDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  if (m < 1 || m > 12) return false;
  const daysInMonth = new Date(Date.UTC(y, m, 0)).getUTCDate();
  return d >= 1 && d <= daysInMonth;
}

export function parseCents(raw: string, field: string, rowNo: number): number {
  const s = raw.trim();
  if (!/^-?\d{1,12}(\.\d{1,2})?$/.test(s)) {
    throw new Error(`row ${rowNo}: ${field} must be a number with at most 2 decimal places: "${raw}"`);
  }
  const [intPart, fracPart] = s.split(".");
  const sign = intPart.startsWith("-") ? -1 : 1;
  const digits = intPart.replace("-", "");
  const frac = (fracPart ?? "").padEnd(2, "0");
  return sign * (parseInt(digits, 10) * 100 + parseInt(frac, 10));
}

export function formatMoney(cents: number, currency: string): string {
  return `${(cents / 100).toFixed(2)} ${currency}`;
}

function reqDate(value: string, field: string, rowNo: number): string {
  const s = value.trim();
  if (!isIsoDate(s)) throw new Error(`row ${rowNo}: ${field} must be an ISO date (YYYY-MM-DD): "${value}"`);
  return s;
}

function reqQuantity(value: string, rowNo: number): number {
  const q = Number(value.trim());
  if (!Number.isFinite(q) || q <= 0) throw new Error(`row ${rowNo}: quantity must be a positive number: "${value}"`);
  return q;
}

function reqSymbol(value: string, rowNo: number): string {
  const s = value.trim().toUpperCase();
  if (s === "") throw new Error(`row ${rowNo}: symbol must not be empty`);
  return s;
}

function loadFile(text: string, fileLabel: string, required: string[]) {
  const { headers, records } = rowsToRecords(parseCsv(text));
  requireColumns(headers, required, fileLabel);
  return { headers, records };
}

export function parseTradesCsv(text: string): Trade[] {
  const { records } = loadFile(text, "trades", ["date", "symbol", "side", "quantity", "price"]);
  const trades: Trade[] = [];
  for (const [i, rec] of records.entries()) {
    const rowNo = i + 2;
    const side = rec.side.trim().toLowerCase();
    if (side !== "buy" && side !== "sell") {
      throw new Error(`row ${rowNo}: side must be "buy" or "sell": "${rec.side}"`);
    }
    trades.push({
      date: reqDate(rec.date, "date", rowNo),
      symbol: reqSymbol(rec.symbol, rowNo),
      side,
      quantity: reqQuantity(rec.quantity, rowNo),
      priceCents: parseCents(rec.price, "price", rowNo),
      currency: (rec.currency ?? "JPY").trim().toUpperCase() || "JPY",
    });
  }
  return trades;
}

export function parseSnapshotsCsv(text: string): Snapshot[] {
  const { records } = loadFile(text, "holdings", ["date", "symbol", "quantity"]);
  const snapshots: Snapshot[] = [];
  for (const [i, rec] of records.entries()) {
    const rowNo = i + 2;
    const costBasis = (rec.cost_basis ?? "").trim();
    snapshots.push({
      date: reqDate(rec.date, "date", rowNo),
      symbol: reqSymbol(rec.symbol, rowNo),
      quantity: reqQuantity(rec.quantity, rowNo),
      costCents: costBasis === "" ? null : parseCents(costBasis, "cost_basis", rowNo),
      currency: (rec.currency ?? "JPY").trim().toUpperCase() || "JPY",
    });
  }
  return snapshots;
}

export function parseDividendsCsv(text: string): DividendEvent[] {
  const { records } = loadFile(text, "dividends", ["symbol", "ex_date", "record_date", "pay_date", "amount_per_share"]);
  const events: DividendEvent[] = [];
  for (const [i, rec] of records.entries()) {
    const rowNo = i + 2;
    const exDate = reqDate(rec.ex_date, "ex_date", rowNo);
    const recordDate = reqDate(rec.record_date, "record_date", rowNo);
    const payDate = reqDate(rec.pay_date, "pay_date", rowNo);
    if (exDate > recordDate) throw new Error(`row ${rowNo}: ex_date (${exDate}) must be on or before record_date (${recordDate})`);
    if (recordDate > payDate) throw new Error(`row ${rowNo}: record_date (${recordDate}) must be on or before pay_date (${payDate})`);
    events.push({
      symbol: reqSymbol(rec.symbol, rowNo),
      exDate,
      recordDate,
      payDate,
      perShareCents: parseCents(rec.amount_per_share, "amount_per_share", rowNo),
      currency: (rec.currency ?? "JPY").trim().toUpperCase() || "JPY",
    });
  }
  return events;
}

export interface HoldingsResult {
  source: "trades" | "snapshots";
  asOfUsed: string;
  dataThroughDate: string | null;
  positions: Position[];
  warnings: string[];
}

export function holdingsFromTrades(trades: Trade[], asOf: string): HoldingsResult {
  const warnings: string[] = [];
  const map = new Map<string, Position>();
  let dataThroughDate: string | null = null;
  const ordered = [...trades].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  for (const t of ordered) {
    if (dataThroughDate === null || t.date > dataThroughDate) dataThroughDate = t.date;
    if (t.date > asOf) continue;
    let p = map.get(t.symbol);
    if (!p) {
      p = {
        symbol: t.symbol,
        quantity: 0,
        costCents: 0,
        avgCostCents: 0,
        realizedCents: 0,
        currency: t.currency,
        lastActivityDate: null,
        tradeCount: 0,
      };
      map.set(t.symbol, p);
    }
    if (p.currency !== t.currency) {
      warnings.push(`${t.symbol}: trade on ${t.date} uses ${t.currency}, position recorded in ${p.currency}`);
    }
    const avgBefore = p.quantity > 0 ? (p.costCents as number) / p.quantity : 0;
    if (t.side === "buy") {
      p.quantity += t.quantity;
      p.costCents = (p.costCents as number) + t.quantity * t.priceCents;
    } else {
      p.realizedCents += t.quantity * (t.priceCents - avgBefore);
      p.quantity -= t.quantity;
      p.costCents = (p.costCents as number) - t.quantity * avgBefore;
    }
    if (p.quantity < -1e-9) {
      warnings.push(`${t.symbol}: quantity is negative (${p.quantity}) after the ${t.side} on ${t.date}`);
    }
    p.lastActivityDate = t.date;
    p.tradeCount += 1;
  }
  for (const p of map.values()) {
    p.avgCostCents = p.quantity > 1e-9 ? (p.costCents as number) / p.quantity : 0;
  }
  const positions = [...map.values()].sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return { source: "trades", asOfUsed: asOf, dataThroughDate, positions, warnings };
}

export function holdingsFromSnapshots(snapshots: Snapshot[], asOf: string): HoldingsResult {
  const warnings: string[] = [];
  const latest = new Map<string, Snapshot>();
  let dataThroughDate: string | null = null;
  for (const s of snapshots) {
    if (dataThroughDate === null || s.date > dataThroughDate) dataThroughDate = s.date;
    if (s.date > asOf) continue;
    const cur = latest.get(s.symbol);
    if (!cur || s.date >= cur.date) latest.set(s.symbol, s);
  }
  const positions: Position[] = [];
  let asOfUsed = "";
  for (const s of latest.values()) {
    if (s.date > asOfUsed) asOfUsed = s.date;
    positions.push({
      symbol: s.symbol,
      quantity: s.quantity,
      costCents: s.costCents === null ? null : s.quantity * s.costCents,
      avgCostCents: s.costCents ?? 0,
      realizedCents: 0,
      currency: s.currency,
      lastActivityDate: s.date,
      tradeCount: 0,
    });
  }
  positions.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  if (latest.size === 0) {
    warnings.push(`no snapshot rows on or before ${asOf}`);
    return { source: "snapshots", asOfUsed: asOf, dataThroughDate, positions, warnings };
  }
  if (dataThroughDate !== null && dataThroughDate > asOfUsed) {
    warnings.push(`using snapshot date ${asOfUsed}; newer snapshots exist (data through ${dataThroughDate})`);
  }
  return { source: "snapshots", asOfUsed: asOfUsed, dataThroughDate, positions, warnings };
}

export interface AllocationResult {
  asOfUsed: string;
  source: "trades" | "snapshots";
  currency: string | null;
  totalQuantity: number;
  totalCostCents: number | null;
  entries: AllocationEntry[];
  warnings: string[];
}

export function buildAllocation(holdings: HoldingsResult): AllocationResult {
  const warnings = [...holdings.warnings];
  const currencies = new Set(holdings.positions.map((p) => p.currency));
  const mixed = currencies.size > 1;
  if (mixed) {
    warnings.push(`mixed currencies (${[...currencies].sort().join(", ")}); cost weights are omitted, quantity weights only`);
  }
  const totalQuantity = holdings.positions.reduce((acc, p) => acc + p.quantity, 0);
  const hasCost = !mixed && holdings.positions.some((p) => p.costCents !== null);
  const totalCostCents = hasCost
    ? holdings.positions.reduce((acc, p) => acc + (p.costCents ?? 0), 0)
    : null;
  const entries: AllocationEntry[] = holdings.positions.map((p) => ({
    symbol: p.symbol,
    quantity: p.quantity,
    quantityWeightPct: totalQuantity > 0 ? Math.round((p.quantity / totalQuantity) * 10000) / 100 : null,
    costCents: mixed ? null : p.costCents,
    costWeightPct:
      totalCostCents !== null && totalCostCents > 0 && p.costCents !== null
        ? Math.round((p.costCents / totalCostCents) * 10000) / 100
        : null,
    currency: p.currency,
    asOfDate: p.lastActivityDate,
  }));
  entries.sort((a, b) => (a.symbol < b.symbol ? -1 : 1));
  return {
    asOfUsed: holdings.asOfUsed,
    source: holdings.source,
    currency: mixed ? null : currencies.size === 1 ? [...currencies][0] : null,
    totalQuantity,
    totalCostCents,
    entries,
    warnings,
  };
}

export interface ChangesResult {
  source: "trades" | "snapshots";
  from: string;
  to: string;
  fromSnapshotDateUsed: string | null;
  toSnapshotDateUsed: string | null;
  symbols: {
    symbol: string;
    quantityBefore: number;
    quantityAfter: number;
    delta: number;
  }[];
  trades: { date: string; symbol: string; side: string; quantity: number; price: string; currency: string }[];
}

export function changesFromTrades(trades: Trade[], from: string, to: string): ChangesResult {
  const quantityBefore = new Map<string, number>();
  const tradesInWindow: Trade[] = [];
  for (const t of trades) {
    if (t.date < from) {
      quantityBefore.set(t.symbol, (quantityBefore.get(t.symbol) ?? 0) + (t.side === "buy" ? t.quantity : -t.quantity));
    } else if (t.date <= to) {
      tradesInWindow.push(t);
    }
  }
  const quantityAfter = new Map(quantityBefore);
  for (const t of tradesInWindow) {
    quantityAfter.set(t.symbol, (quantityAfter.get(t.symbol) ?? 0) + (t.side === "buy" ? t.quantity : -t.quantity));
  }
  const symbols = [...new Set([...quantityBefore.keys(), ...quantityAfter.keys()])]
    .sort()
    .map((symbol) => {
      const quantityB = quantityBefore.get(symbol) ?? 0;
      const quantityA = quantityAfter.get(symbol) ?? 0;
      return { symbol, quantityBefore: quantityB, quantityAfter: quantityA, delta: quantityA - quantityB };
    });
  const orderedTrades = [...tradesInWindow].sort((a, b) => (a.date < b.date ? -1 : a.date > b.date ? 1 : 0));
  return {
    source: "trades",
    from,
    to,
    fromSnapshotDateUsed: null,
    toSnapshotDateUsed: null,
    symbols,
    trades: orderedTrades.map((t) => ({
      date: t.date,
      symbol: t.symbol,
      side: t.side,
      quantity: t.quantity,
      price: formatMoney(t.priceCents, t.currency),
      currency: t.currency,
    })),
  };
}

function snapshotsUpTo(snapshots: Snapshot[], date: string): Map<string, Snapshot> {
  const latest = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (s.date > date) continue;
    const cur = latest.get(s.symbol);
    if (!cur || s.date >= cur.date) latest.set(s.symbol, s);
  }
  return latest;
}

export function changesFromSnapshots(snapshots: Snapshot[], from: string, to: string): ChangesResult {
  const latestBeforeFrom = new Map<string, Snapshot>();
  for (const s of snapshots) {
    if (s.date >= from) continue;
    const cur = latestBeforeFrom.get(s.symbol);
    if (!cur || s.date >= cur.date) latestBeforeFrom.set(s.symbol, s);
  }
  const latestAtTo = snapshotsUpTo(snapshots, to);
  const pickDate = (map: Map<string, Snapshot>): string | null => {
    let best: string | null = null;
    for (const s of map.values()) if (best === null || s.date > best) best = s.date;
    return best;
  };
  const symbols = [...new Set([...latestBeforeFrom.keys(), ...latestAtTo.keys()])]
    .sort()
    .map((symbol) => {
      const quantityBefore = latestBeforeFrom.get(symbol)?.quantity ?? 0;
      const quantityAfter = latestAtTo.get(symbol)?.quantity ?? 0;
      return { symbol, quantityBefore, quantityAfter, delta: quantityAfter - quantityBefore };
    });
  return {
    source: "snapshots",
    from,
    to,
    fromSnapshotDateUsed: pickDate(latestBeforeFrom),
    toSnapshotDateUsed: pickDate(latestAtTo),
    symbols,
    trades: [],
  };
}

export interface DividendScheduleEntry {
  symbol: string;
  exDate: string;
  recordDate: string;
  payDate: string;
  amountPerShare: string;
  sharesHeldAsOfExDate: number;
  expectedPayout: string;
  currency: string;
  status: "upcoming" | "past";
}

export interface DividendScheduleResult {
  asOf: string;
  until: string | null;
  entries: DividendScheduleEntry[];
  notes: string[];
}

export function dividendSchedule(
  dividends: DividendEvent[],
  quantityAt: (symbol: string, date: string) => number,
  asOf: string,
  until?: string,
  includePast = false
): DividendScheduleResult {
  const entries: DividendScheduleEntry[] = [];
  for (const d of dividends) {
    const past = d.exDate < asOf;
    if (past && !includePast) continue;
    if (until !== undefined && d.exDate > until) continue;
    const shares = quantityAt(d.symbol, d.exDate);
    entries.push({
      symbol: d.symbol,
      exDate: d.exDate,
      recordDate: d.recordDate,
      payDate: d.payDate,
      amountPerShare: formatMoney(d.perShareCents, d.currency),
      sharesHeldAsOfExDate: shares,
      expectedPayout: formatMoney(Math.round(shares * d.perShareCents), d.currency),
      currency: d.currency,
      status: past ? "past" : "upcoming",
    });
  }
  entries.sort((a, b) =>
    a.payDate < b.payDate ? -1 : a.payDate > b.payDate ? 1 : a.symbol < b.symbol ? -1 : 1
  );
  return {
    asOf,
    until: until ?? null,
    entries,
    notes: [
      "Expected payout assumes the quantity held on the ex-date stays unchanged until the record date.",
      "Facts and dated projections only; this is not buy or sell advice.",
    ],
  };
}
