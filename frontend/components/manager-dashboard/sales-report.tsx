"use client";

import { Banknote, Calculator, CreditCard, IndianRupee, ShoppingBag, Wallet, WalletCards } from "lucide-react";
import { formatNumber, formatPct, formatRupees, pct, periodChange } from "@/lib/manager-analytics";
import type { ManagerAnalytics } from "@/lib/api-client/types/manager-analytics.types";
import { Table, TableBody, TableCell, TableFooter, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Avatar, KpiCard } from "./kpi-card";
import { EmptyState, Panel } from "./panel";

const aov = (revenue: number, orders: number) => (orders > 0 ? revenue / orders : 0);
/** "Collected ₹X of ₹Y": cash received against order value, so booked COD is never read as cash in hand. */
const collectedLine = (collected: number, value: number) =>
  value > 0 ? { text: `Collected ${formatRupees(collected)} · ${formatPct(pct(collected, value), 0)}` } : { text: "Nothing to collect" };

/**
 * The seven Sales & Revenue KPIs. One grid: three per row on desktop (3 / 3 / 1), two on tablets, stacked on phones.
 * Revenue figures are order value net of refunds; the second line on each shows what has actually been collected.
 */
export function SalesSummaryTiles({ data }: { data: ManagerAnalytics }) {
  const k = data.kpis;
  const unknown = k.orders - k.codOrders - k.prepaidOrders;
  return (
    <section className="space-y-3" aria-label="Sales summary">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-3">
        <KpiCard
          label="Total Orders" tone="blue" icon={ShoppingBag} value={formatNumber(k.orders)}
          lines={[periodChange(k.orders, k.previousOrders), { text: `Previous period: ${formatNumber(k.previousOrders)}` }]}
        />
        <KpiCard
          label="AOV (Average Order Value)" tone="violet" icon={Calculator} value={formatRupees(k.aov)}
          lines={[{ text: k.orders > 0 ? `Order value ÷ ${formatNumber(k.orders)} ${k.orders === 1 ? "order" : "orders"}` : "No orders in this period" }]}
        />
        <KpiCard
          label="Revenue" tone="emerald" icon={IndianRupee} value={formatRupees(k.revenue)}
          lines={[periodChange(k.revenue, k.previousRevenue), collectedLine(k.collected, k.revenue)]}
        />
        <KpiCard label="COD Orders" tone="amber" icon={Banknote} value={formatNumber(k.codOrders)} lines={[{ text: `${formatPct(pct(k.codOrders, k.orders))} of orders` }]} />
        <KpiCard label="Prepaid Orders" tone="teal" icon={CreditCard} value={formatNumber(k.prepaidOrders)} lines={[{ text: `${formatPct(pct(k.prepaidOrders, k.orders))} of orders` }]} />
        <KpiCard
          label="Revenue — COD" tone="amber" icon={Wallet} value={formatRupees(k.codRevenue)}
          lines={[collectedLine(k.codCollected, k.codRevenue), { text: `AOV ${formatRupees(aov(k.codRevenue, k.codOrders))}` }]}
        />
        <KpiCard
          label="Revenue — Prepaid" tone="teal" icon={WalletCards} value={formatRupees(k.prepaidRevenue)}
          lines={[collectedLine(k.prepaidCollected, k.prepaidRevenue), { text: `AOV ${formatRupees(aov(k.prepaidRevenue, k.prepaidOrders))}` }]}
        />
      </div>
      <p className="text-xs text-muted-foreground">
        Revenue is order value net of refunds for confirmed-to-delivered orders; cancelled, returned and refunded orders are excluded.
        Collected counts only payments marked paid, so COD is collected once its payment is confirmed.
        {unknown > 0 ? ` ${formatNumber(unknown)} ${unknown === 1 ? "order has" : "orders have"} no payment method yet: counted in the totals, not in COD or Prepaid.` : ""}
      </p>
    </section>
  );
}

/** Who took how many orders, and of which type. Highest revenue first; a row opens that salesperson's report. */
export function SalespersonOrdersTable({ data, onOpen }: { data: ManagerAnalytics; onOpen: (id: string) => void }) {
  const rows = [...data.salespeople].sort((a, b) => b.revenue - a.revenue || b.orders - a.orders);
  const k = data.kpis;
  const num = "text-right tabular-nums";

  return (
    <Panel title="Orders by Salesperson" description="How many orders each salesperson took, split by COD and Prepaid. Select a row to open their report." bodyClassName="p-0 sm:p-0">
      {rows.length === 0 ? (
        <EmptyState>No salespeople in this selection.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Salesperson</TableHead>
                <TableHead className={num}>Orders</TableHead>
                <TableHead className={num}>COD</TableHead>
                <TableHead className={num}>Prepaid</TableHead>
                <TableHead className={num}>Revenue</TableHead>
                <TableHead className={num}>COD Revenue</TableHead>
                <TableHead className={num}>Prepaid Revenue</TableHead>
                <TableHead className={`${num} pr-5`}>AOV</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.map((p) => (
                <TableRow
                  key={p.id}
                  className="cursor-pointer"
                  tabIndex={0}
                  onClick={() => onOpen(p.id)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") onOpen(p.id);
                  }}
                >
                  <TableCell className="pl-5">
                    <div className="flex items-center gap-2.5">
                      <Avatar name={p.name} className="size-7" />
                      <span className="truncate font-medium">{p.name}</span>
                    </div>
                  </TableCell>
                  <TableCell className={`${num} font-medium`}>{formatNumber(p.orders)}</TableCell>
                  <TableCell className={num}>{formatNumber(p.codOrders)}</TableCell>
                  <TableCell className={num}>{formatNumber(p.prepaidOrders)}</TableCell>
                  <TableCell className={`${num} font-medium`}>{formatRupees(p.revenue)}</TableCell>
                  <TableCell className={num}>{formatRupees(p.codRevenue)}</TableCell>
                  <TableCell className={num}>{formatRupees(p.prepaidRevenue)}</TableCell>
                  <TableCell className={`${num} pr-5 text-muted-foreground`}>{formatRupees(aov(p.revenue, p.orders))}</TableCell>
                </TableRow>
              ))}
            </TableBody>
            <TableFooter>
              <TableRow>
                <TableCell className="pl-5">Team total</TableCell>
                <TableCell className={num}>{formatNumber(k.orders)}</TableCell>
                <TableCell className={num}>{formatNumber(k.codOrders)}</TableCell>
                <TableCell className={num}>{formatNumber(k.prepaidOrders)}</TableCell>
                <TableCell className={num}>{formatRupees(k.revenue)}</TableCell>
                <TableCell className={num}>{formatRupees(k.codRevenue)}</TableCell>
                <TableCell className={num}>{formatRupees(k.prepaidRevenue)}</TableCell>
                <TableCell className={`${num} pr-5`}>{formatRupees(aov(k.revenue, k.orders))}</TableCell>
              </TableRow>
            </TableFooter>
          </Table>
        </div>
      )}
    </Panel>
  );
}

/** Which products sold in the period, how much, of which payment type, and who sold the most of each. */
export function ProductSalesTable({ data, onOpen }: { data: ManagerAnalytics; onOpen: (id: string) => void }) {
  const products = data.products;
  const totalRevenue = products.reduce((a, p) => a + p.revenue, 0);
  const num = "text-right tabular-nums";

  return (
    <Panel
      title="Products Sold"
      description="Units and revenue per product (variants combined). Product revenue is line totals, so it excludes shipping and order discounts."
      bodyClassName="p-0 sm:p-0"
    >
      {products.length === 0 ? (
        <EmptyState>No products sold in this period.</EmptyState>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="pl-5">Product</TableHead>
                <TableHead className={num}>Orders</TableHead>
                <TableHead className={num}>Units</TableHead>
                <TableHead className={num}>COD</TableHead>
                <TableHead className={num}>Prepaid</TableHead>
                <TableHead className={num}>Revenue</TableHead>
                <TableHead className={num}>Share</TableHead>
                <TableHead className="pr-5">Top Salesperson</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {products.map((p) => (
                <TableRow key={p.key}>
                  <TableCell className="max-w-72 pl-5">
                    <div className="truncate font-medium" title={p.name}>{p.name}</div>
                    {p.sku ? <div className="font-mono text-xs text-muted-foreground">{p.sku}</div> : null}
                  </TableCell>
                  <TableCell className={num}>{formatNumber(p.orders)}</TableCell>
                  <TableCell className={`${num} font-medium`}>{formatNumber(p.units)}</TableCell>
                  <TableCell className={num}>{formatNumber(p.codOrders)}</TableCell>
                  <TableCell className={num}>{formatNumber(p.prepaidOrders)}</TableCell>
                  <TableCell className={`${num} font-medium`}>{formatRupees(p.revenue)}</TableCell>
                  <TableCell className={`${num} text-muted-foreground`}>{formatPct(pct(p.revenue, totalRevenue))}</TableCell>
                  <TableCell className="pr-5">
                    {p.topSalesperson ? (
                      <button type="button" className="text-left hover:underline" onClick={() => onOpen(p.topSalesperson!.id)}>
                        {p.topSalesperson.name}
                        <span className="text-muted-foreground"> · {formatNumber(p.topSalesperson.units)} units</span>
                        {p.sellers > 1 ? <span className="text-muted-foreground"> (of {p.sellers})</span> : null}
                      </button>
                    ) : (
                      <span className="text-muted-foreground">—</span>
                    )}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </Panel>
  );
}
