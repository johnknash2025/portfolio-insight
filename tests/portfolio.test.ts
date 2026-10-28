import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseCsv, rowsToRecords } from "../src/csv.ts";
import {
  parseTradesCsv,
  parseSnapshotsCsv,
  parseDividendsCsv,
  parseCents,
  isIsoDate,
  holdingsFromTrades,
  holdingsFromSnapshots,
  buildAllocation,
  changesFromTrades,
  changesFromSnapshots,
  dividendSchedule,
} from "../src/portfolio.ts";

const TRADES_CSV = [
  "date,symbol,side,quantity,price,currency",
  "2024-01-10,TM,buy,40,210.00,USD",
  "2024-03-15,AAPL,buy,25,170.50,USD",
  "2024-06-10,TM,sell,10,230.00,USD",
  "2024-09-12,AAPL,buy,15,205.00,USD",
  "2025-01-08,TM,buy,5,218.40,USD",
  "",
].join("\n");

const SNAPSHOTS_CSV = [
  "date,symbol,quantity,cost_basis,currency",
  "2024-12-31,TM,30,210.00,USD",
  "2024-12-31,AAPL,40,183.44,USD",
  "2025-06-30,TM,35,211.20,USD",
  "2025-06-30,AAPL,40,183.44,USD",
  "",
].join("\n");

const DIVIDENDS_CSV = [
  "symbol,ex_date,record_date,pay_date,amount_per_share,currency",
  "TM,2024-09-27,2024-09-30,2024-12-06,1.10,USD",
  "TM,2025-03-21,2025-03-24,2025-06-06,1.15,USD",
  "TM,2025-09-19,2025-09-22,2025-12-05,1.20,USD",
  "AAPL,2025-02-07,2025-02-10,2025-02-14,0.24,USD",
  "AAPL,2025-05-09,2025-05-12,2025-05-16,0.26,USD",
  "AAPL,2025-08-07,2025-08-11,2025-08-15,0.26,USD",
  "AAPL,2026-02-05,2026-02-10,2026-02-13,0.26,USD",
  "",
].join("\n");

test("parseCsv handles quotes, escaped quotes and CRLF", () => {
  const rows = parseCsv('a,b\n"say ""hi""",x,y\r\n"comma,inside",2\r\n');
  assert.deepEqual(rows, [
    ["a", "b"],
    ['say "hi"', "x", "y"],
    ["comma,inside", "2"],
  ]);
});

test("rowsToRecords lowercases headers and skips empty lines", () => {
  const { headers, records } = rowsToRecords(parseCsv("Date,Symbol\n2024-01-01,TM\n\n"));
  assert.deepEqual(headers, ["date", "symbol"]);
  assert.deepEqual(records, [{ date: "2024-01-01", symbol: "TM" }]);
});

test("parseCents", () => {
  assert.equal(parseCents("170.50", "price", 2), 17050);
  assert.equal(parseCents("0.24", "amount_per_share", 2), 24);
  assert.equal(parseCents("230", "price", 2), 23000);
  assert.equal(parseCents("-1.05", "price", 2), -105);
  assert.throws(() => parseCents("1.234", "price", 3), /row 3/);
});

test("isIsoDate", () => {
  assert.ok(isIsoDate("2024-02-29"));
  assert.ok(!isIsoDate("2025-02-29"));
  assert.ok(!isIsoDate("2025-13-01"));
  assert.ok(!isIsoDate("2025/01/01"));
});

test("holdingsFromTrades computes quantity, weighted average cost and realized gain", () => {
  const trades = parseTradesCsv(TRADES_CSV);
  const result = holdingsFromTrades(trades, "2024-12-31");
  assert.equal(result.source, "trades");
  assert.deepEqual(result.positions.map((p) => p.symbol), ["AAPL", "TM"]);
  const aapl = result.positions[0];
  const tm = result.positions[1];
  assert.equal(aapl.quantity, 40);
  assert.equal(aapl.avgCostCents, 18343.75);
  assert.equal(aapl.costCents, 733750);
  assert.equal(aapl.realizedCents, 0);
  assert.equal(tm.quantity, 30);
  assert.equal(tm.avgCostCents, 21000);
  assert.equal(tm.realizedCents, 20000);
  assert.equal(tm.lastActivityDate, "2024-06-10");
  assert.equal(result.positions[1].tradeCount, 2);
  assert.deepEqual(result.warnings, []);
});

test("holdingsFromTrades ignores future trades and reports data end date", () => {
  const result = holdingsFromTrades(parseTradesCsv(TRADES_CSV), "2024-12-31");
  assert.equal(result.dataThroughDate, "2025-01-08");
  const withLaterBuy = holdingsFromTrades(parseTradesCsv(TRADES_CSV), "2025-01-08");
  const tm = withLaterBuy.positions.find((p) => p.symbol === "TM");
  assert.equal(tm.quantity, 35);
  assert.equal(tm.avgCostCents, (30 * 21000 + 5 * 21840) / 35);
});

test("buildAllocation returns quantity and cost weights with as-of date", () => {
  const holdings = holdingsFromTrades(parseTradesCsv(TRADES_CSV), "2024-12-31");
  const alloc = buildAllocation(holdings);
  assert.equal(alloc.asOfUsed, "2024-12-31");
  assert.equal(alloc.currency, "USD");
  assert.equal(alloc.totalQuantity, 70);
  assert.equal(alloc.totalCostCents, 1363750);
  const aapl = alloc.entries[0];
  const tm = alloc.entries[1];
  assert.equal(aapl.quantityWeightPct, 57.14);
  assert.equal(aapl.costWeightPct, 53.8);
  assert.equal(tm.quantityWeightPct, 42.86);
  assert.equal(tm.costWeightPct, 46.2);
  assert.equal(aapl.asOfDate, "2024-09-12");
  assert.equal(tm.asOfDate, "2024-06-10");
});

test("buildAllocation omits cost weights when currencies are mixed", () => {
  const snapshots = parseSnapshotsCsv(
    "date,symbol,quantity,cost_basis,currency\n2024-12-31,TM,30,210.00,USD\n2024-12-31,7203,100,2800.00,JPY\n"
  );
  const alloc = buildAllocation(holdingsFromSnapshots(snapshots, "2024-12-31"));
  assert.equal(alloc.currency, null);
  assert.equal(alloc.totalCostCents, null);
  assert.ok(alloc.entries.every((e) => e.costWeightPct === null));
  assert.ok(alloc.entries.every((e) => e.quantityWeightPct !== null));
  assert.ok(alloc.warnings.some((w) => w.includes("mixed currencies")));
});

test("holdingsFromSnapshots uses the latest snapshot on or before as_of", () => {
  const snapshots = parseSnapshotsCsv(SNAPSHOTS_CSV);
  const june = holdingsFromSnapshots(snapshots, "2025-06-30");
  assert.equal(june.asOfUsed, "2025-06-30");
  assert.deepEqual(june.positions.map((p) => p.quantity), [40, 35]);
  const tm = june.positions.find((p) => p.symbol === "TM");
  assert.equal(tm.costCents, 35 * 21120);

  const april = holdingsFromSnapshots(snapshots, "2025-04-01");
  assert.equal(april.asOfUsed, "2024-12-31");
  assert.deepEqual(april.positions.map((p) => p.quantity), [40, 30]);
  assert.ok(april.warnings.some((w) => w.includes("newer snapshots exist")));
});

test("changesFromTrades reports dated deltas and the trade list", () => {
  const trades = parseTradesCsv(TRADES_CSV);
  const full = changesFromTrades(trades, "2024-01-01", "2024-12-31");
  assert.deepEqual(
    full.symbols,
    [
      { symbol: "AAPL", quantityBefore: 0, quantityAfter: 40, delta: 40 },
      { symbol: "TM", quantityBefore: 0, quantityAfter: 30, delta: 30 },
    ]
  );
  assert.equal(full.trades.length, 4);
  assert.deepEqual(full.trades[2], {
    date: "2024-06-10",
    symbol: "TM",
    side: "sell",
    quantity: 10,
    price: "230.00 USD",
    currency: "USD",
  });

  const half = changesFromTrades(trades, "2024-06-30", "2024-12-31");
  assert.deepEqual(
    half.symbols,
    [
      { symbol: "AAPL", quantityBefore: 25, quantityAfter: 40, delta: 15 },
      { symbol: "TM", quantityBefore: 30, quantityAfter: 30, delta: 0 },
    ]
  );
  assert.equal(half.trades.length, 1);
});

test("changesFromSnapshots reports the snapshot dates used", () => {
  const changes = changesFromSnapshots(parseSnapshotsCsv(SNAPSHOTS_CSV), "2025-01-01", "2025-06-30");
  assert.equal(changes.source, "snapshots");
  assert.equal(changes.fromSnapshotDateUsed, "2024-12-31");
  assert.equal(changes.toSnapshotDateUsed, "2025-06-30");
  assert.deepEqual(
    changes.symbols,
    [
      { symbol: "AAPL", quantityBefore: 40, quantityAfter: 40, delta: 0 },
      { symbol: "TM", quantityBefore: 30, quantityAfter: 35, delta: 5 },
    ]
  );
});

test("dividendSchedule projects payouts from quantity held on the ex-date", () => {
  const trades = parseTradesCsv(TRADES_CSV);
  const dividends = parseDividendsCsv(DIVIDENDS_CSV);
  const quantityAt = (symbol: string, date: string) =>
    holdingsFromTrades(trades, date).positions.find((p) => p.symbol === symbol)?.quantity ?? 0;

  const upcoming = dividendSchedule(dividends, quantityAt, "2025-01-01");
  assert.deepEqual(
    upcoming.entries.map((e) => `${e.symbol}:${e.payDate}:${e.expectedPayout}`),
    [
      "AAPL:2025-02-14:9.60 USD",
      "AAPL:2025-05-16:10.40 USD",
      "TM:2025-06-06:40.25 USD",
      "AAPL:2025-08-15:10.40 USD",
      "TM:2025-12-05:42.00 USD",
      "AAPL:2026-02-13:10.40 USD",
    ]
  );
  assert.ok(upcoming.entries.every((e) => e.status === "upcoming"));

  const windowed = dividendSchedule(dividends, quantityAt, "2025-01-01", "2025-06-30");
  assert.equal(windowed.entries.length, 3);
  assert.deepEqual(windowed.entries.map((e) => `${e.symbol}:${e.exDate}`), [
    "AAPL:2025-02-07",
    "AAPL:2025-05-09",
    "TM:2025-03-21",
  ].sort());

  const withPast = dividendSchedule(dividends, quantityAt, "2025-01-01", undefined, true);
  const past = withPast.entries[0];
  assert.deepEqual([past.symbol, past.status, past.sharesHeldAsOfExDate, past.expectedPayout], [
    "TM",
    "past",
    30,
    "33.00 USD",
  ]);
});

test("validation rejects malformed rows with row numbers", () => {
  assert.throws(() => parseTradesCsv("date,symbol,side,quantity,price\n2024-01-10,TM,hodl,40,210.00\n"), /row 2: side/);
  assert.throws(() => parseTradesCsv("date,symbol,side,quantity,price\n2024-13-01,TM,buy,40,210.00\n"), /row 2: date/);
  assert.throws(() => parseTradesCsv("date,symbol,side,quantity,price\n2024-01-10,,buy,40,210.00\n"), /row 2: symbol/);
  assert.throws(() => parseTradesCsv("date,symbol,side,quantity,price\n2024-01-10,TM,buy,-40,210.00\n"), /row 2: quantity/);
  assert.throws(() => parseTradesCsv("date,side\n2024-01-10,buy\n"), /missing required column/);
  assert.throws(
    () => parseDividendsCsv("symbol,ex_date,record_date,pay_date,amount_per_share\nTM,2025-03-24,2025-03-21,2025-06-06,1.15\n"),
    /row 2: ex_date/
  );
});

test("selling more than held is reported as a warning, not hidden", () => {
  const trades = parseTradesCsv(
    "date,symbol,side,quantity,price,currency\n2024-01-10,TM,buy,10,210.00,USD\n2024-02-10,TM,sell,15,230.00,USD\n"
  );
  const result = holdingsFromTrades(trades, "2024-12-31");
  assert.equal(result.positions[0].quantity, -5);
  assert.ok(result.warnings.some((w) => w.includes("negative")));
});

test("repo sample data parses cleanly", () => {
  const trades = parseTradesCsv(readFileSync("data/trades.csv", "utf8"));
  const snapshots = parseSnapshotsCsv(readFileSync("data/holdings.csv", "utf8"));
  const dividends = parseDividendsCsv(readFileSync("data/dividends.csv", "utf8"));
  assert.equal(trades.length, 5);
  assert.equal(snapshots.length, 4);
  assert.equal(dividends.length, 7);
  const snapshotDerived = holdingsFromSnapshots(snapshots, "2025-06-30");
  const tradeDerived = holdingsFromTrades(trades, "2025-06-30");
  assert.deepEqual(
    snapshotDerived.positions.map((p) => `${p.symbol}:${p.quantity}`),
    tradeDerived.positions.map((p) => `${p.symbol}:${p.quantity}`)
  );
});
