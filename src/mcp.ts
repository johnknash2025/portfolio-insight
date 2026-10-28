import { readFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  parseTradesCsv,
  parseSnapshotsCsv,
  parseDividendsCsv,
  holdingsFromTrades,
  holdingsFromSnapshots,
  buildAllocation,
  changesFromTrades,
  changesFromSnapshots,
  dividendSchedule,
  isIsoDate,
} from "./portfolio.ts";
import type { DividendEvent, Snapshot, Trade } from "./portfolio.ts";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "expected ISO date YYYY-MM-DD");

const dataDir = resolve(process.argv[2] ?? process.env.PORTFOLIO_INSIGHT_DATA_DIR ?? "data");

function readCsv(fileName: string): string | null {
  const path = resolve(dataDir, fileName);
  if (!existsSync(path)) return null;
  return readFileSync(path, "utf8");
}

function loadData() {
  const tradesText = readCsv("trades.csv");
  const snapshotsText = readCsv("holdings.csv");
  const dividendsText = readCsv("dividends.csv");
  const trades: Trade[] = tradesText === null ? [] : parseTradesCsv(tradesText);
  const snapshots: Snapshot[] = snapshotsText === null ? [] : parseSnapshotsCsv(snapshotsText);
  const dividends: DividendEvent[] = dividendsText === null ? [] : parseDividendsCsv(dividendsText);
  const dates = [...trades.map((t) => t.date), ...snapshots.map((s) => s.date)];
  const dataThroughDate = dates.length > 0 ? dates.reduce((a, b) => (a > b ? a : b)) : null;
  return { trades, snapshots, dividends, dataThroughDate, hasHoldingsSource: trades.length > 0 || snapshots.length > 0 };
}

type LoadedData = ReturnType<typeof loadData>;

function defaultAsOf(dataThroughDate: string | null): string {
  if (dataThroughDate === null) throw new Error("no holdings data found; expected data/trades.csv or data/holdings.csv");
  return dataThroughDate;
}

function currentHoldings(data: LoadedData, asOf: string) {
  const { trades, snapshots } = data;
  if (trades.length > 0) return holdingsFromTrades(trades, asOf);
  return holdingsFromSnapshots(snapshots, asOf);
}

function quantitySource(data: LoadedData): (symbol: string, date: string) => number {
  const { trades, snapshots } = data;
  if (trades.length > 0) {
    return (symbol, date) => {
      const pos = holdingsFromTrades(trades, date).positions.find((p) => p.symbol === symbol);
      return pos ? pos.quantity : 0;
    };
  }
  return (symbol, date) => {
    const pos = holdingsFromSnapshots(snapshots, date).positions.find((p) => p.symbol === symbol);
    return pos ? pos.quantity : 0;
  };
}

const server = new McpServer(
  { name: "portfolio-insight", version: "0.1.0" },
  {
    instructions:
      "Portfolio Insight local MCP. Reads local CSV files (trades.csv, holdings.csv, dividends.csv) and answers with facts and dates only: positions, allocation weights, dated changes, dividend schedule. It never gives buy or sell advice. Stdio transport only; data never leaves this machine.",
  }
);

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload, null, 2) }] };
}

function fail(message: string) {
  return { content: [{ type: "text" as const, text: JSON.stringify({ error: message }) }], isError: true };
}

function guard(handler: () => unknown) {
  try {
    return ok(handler());
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return fail(message);
  }
}

server.registerTool(
  "portfolio_holdings",
  {
    title: "Portfolio holdings",
    description:
      "Positions (quantity, average cost basis, realized gain/loss) as of a date, derived from trades.csv or holdings.csv. Facts with dates only; no buy/sell advice.",
    inputSchema: {
      as_of: isoDate.optional().describe("ISO date to value holdings at; defaults to the latest date in the data"),
    },
  },
  (args) =>
    guard(() => {
      const data = loadData();
      const asOf = args.as_of ?? defaultAsOf(data.dataThroughDate);
      return currentHoldings(data, asOf);
    })
);

server.registerTool(
  "portfolio_allocation",
  {
    title: "Portfolio allocation",
    description:
      "Allocation weights (quantity-based and cost-based percentages) as of a date, from trades.csv or holdings.csv. Facts with dates only; no buy/sell advice.",
    inputSchema: {
      as_of: isoDate.optional().describe("ISO date; defaults to the latest date in the data"),
    },
  },
  (args) =>
    guard(() => {
      const data = loadData();
      const asOf = args.as_of ?? defaultAsOf(data.dataThroughDate);
      const holdings = currentHoldings(data, asOf);
      if (holdings.positions.length === 0) throw new Error(`no positions on or before ${asOf}`);
      return buildAllocation(holdings);
    })
);

server.registerTool(
  "portfolio_changes",
  {
    title: "Portfolio changes between dates",
    description:
      "Quantity before/after and per-symbol delta between two dates, plus the dated trade list (for trades.csv) or the snapshot dates used (for holdings.csv). Facts with dates only; no buy/sell advice.",
    inputSchema: {
      from: isoDate.describe("window start date (inclusive)"),
      to: isoDate.describe("window end date (inclusive)"),
    },
  },
  (args) =>
    guard(() => {
      if (args.from > args.to) throw new Error(`from (${args.from}) must be on or before to (${args.to})`);
      const data = loadData();
      if (data.trades.length > 0) return changesFromTrades(data.trades, args.from, args.to);
      if (data.snapshots.length > 0) return changesFromSnapshots(data.snapshots, args.from, args.to);
      throw new Error("no holdings data found; expected data/trades.csv or data/holdings.csv");
    })
);

server.registerTool(
  "dividend_schedule",
  {
    title: "Dividend schedule",
    description:
      "Dated dividend events (ex-date, record date, pay date, per-share amount) from dividends.csv with expected payouts based on quantity held on the ex-date. Facts and dated projections only; no buy/sell advice.",
    inputSchema: {
      as_of: isoDate.optional().describe("events with ex-date on or after this date; defaults to the latest date in the holdings data"),
      until: isoDate.optional().describe("optional last date (inclusive) for the schedule window"),
      include_past: z.boolean().optional().describe("also list events whose ex-date is before as_of, marked status=past"),
    },
  },
  (args) =>
    guard(() => {
      const data = loadData();
      if (data.dividends.length === 0) throw new Error("no dividend data found; expected data/dividends.csv");
      const asOf = args.as_of ?? defaultAsOf(data.dataThroughDate);
      if (args.until !== undefined && args.until < asOf) throw new Error(`until (${args.until}) must be on or after as_of (${asOf})`);
      return dividendSchedule(data.dividends, quantitySource(data), asOf, args.until, args.include_past ?? false);
    })
);

async function main(): Promise<void> {
  const { trades, snapshots, dividends, dataThroughDate, hasHoldingsSource } = loadData();
  console.error(
    `portfolio-insight MCP (local only) data dir: ${dataDir}; ` +
      `trades=${trades.length} snapshots=${snapshots.length} dividends=${dividends.length} ` +
      `dataThrough=${dataThroughDate ?? "n/a"}`
  );
  if (!hasHoldingsSource && dividends.length === 0) {
    console.error("warning: no CSV files found in the data directory");
  }
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
