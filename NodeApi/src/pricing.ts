export interface PricedLine {
  unitPrice: number;
  quantity: number;
  discountPercent: number;
}

export function roundCurrency(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

export function calculateSaleTotals(
  lines: readonly PricedLine[],
  orderDiscountPercent: number,
): { subtotal: number; lineDiscount: number; orderDiscount: number; total: number } {
  const lineAmounts = lines.map((line) => {
    const gross = roundCurrency(line.unitPrice * line.quantity);
    return {
      subtotal: gross,
      discount: roundCurrency(gross * line.discountPercent / 100),
    };
  });
  const subtotal = roundCurrency(lineAmounts.reduce(
    (sum, line) => sum + line.subtotal - line.discount,
    0,
  ));
  const lineDiscount = roundCurrency(lineAmounts.reduce((sum, line) => sum + line.discount, 0));
  const orderDiscount = roundCurrency(subtotal * orderDiscountPercent / 100);
  return {
    subtotal,
    lineDiscount,
    orderDiscount,
    total: roundCurrency(subtotal - orderDiscount),
  };
}
