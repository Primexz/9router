"use client";

import PropTypes from "prop-types";
import AnimatedNumber from "@/shared/components/AnimatedNumber";
import Card from "@/shared/components/Card";

const fmt = (n) => new Intl.NumberFormat().format(n || 0);
const fmtInteger = (n) => fmt(Math.round(n));
const fmtCost = (n) => `$${(n || 0).toFixed(2)}`;

export default function OverviewCards({ stats }) {
  return (
    <div className="grid min-w-0 grid-cols-1 gap-3 sm:grid-cols-2 md:grid-cols-3 lg:grid-cols-5 sm:gap-4">
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Requests</span>
        <AnimatedNumber value={stats.totalRequests} formatter={fmtInteger} className="truncate text-2xl font-bold" />
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Total Input Tokens</span>
        <AnimatedNumber value={stats.totalPromptTokens} formatter={fmtInteger} className="truncate text-2xl font-bold text-primary" />
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Cached Tokens</span>
        <AnimatedNumber value={stats.totalCachedTokens} formatter={fmtInteger} className="truncate text-2xl font-bold text-info" />
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Output Tokens</span>
        <AnimatedNumber value={stats.totalCompletionTokens} formatter={fmtInteger} className="truncate text-2xl font-bold text-success" />
      </Card>
      <Card className="flex min-w-0 flex-col gap-1 px-4 py-3">
        <span className="text-text-muted text-sm uppercase font-semibold">Est. Cost</span>
        <AnimatedNumber value={stats.totalCost} formatter={fmtCost} decimalPlaces={2} prefix="~" className="truncate text-2xl font-bold text-warning" />
        <span className="text-[10px] text-text-muted">Estimated, not actual billing</span>
      </Card>
    </div>
  );
}

OverviewCards.propTypes = {
  stats: PropTypes.object.isRequired,
};
