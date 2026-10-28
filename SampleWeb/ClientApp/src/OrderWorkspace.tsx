import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  createPurchase, createSale, getPurchases, getSales, listProducts,
  type PurchaseSummary, type SaleSummary,
} from "./api";
import type { Product } from "./types";

type OrderLine = {
  productId: string;
  quantity: number;
  discountPercent: number;
  unitCost: number;
};

export default function OrderWorkspace({
  mode,
  onComplete,
}: {
  mode: "sales" | "purchases";
  onComplete: () => Promise<void>;
}) {
  const isSale = mode === "sales";
  const [products, setProducts] = useState<Product[]>([]);
  const [orders, setOrders] = useState<Array<SaleSummary | PurchaseSummary>>([]);
  const [lines, setLines] = useState<OrderLine[]>([]);
  const [productId, setProductId] = useState("");
  const [quantity, setQuantity] = useState("1");
  const [discountPercent, setDiscountPercent] = useState("0");
  const [orderDiscountPercent, setOrderDiscountPercent] = useState("0");
  const [unitCost, setUnitCost] = useState("");
  const [partyName, setPartyName] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");

  const refreshOrders = useCallback(async () => {
    setOrders(isSale ? await getSales() : await getPurchases());
  }, [isSale]);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const first = await listProducts(new URLSearchParams({ page: "1", pageSize: "100" }));
        const pages = Math.ceil(first.totalCount / first.pageSize);
        const result = [...first.items];
        for (let page = 2; page <= pages; page++) {
          result.push(...(await listProducts(new URLSearchParams({ page: String(page), pageSize: "100" }))).items);
        }
        await refreshOrders();
        if (active) setProducts(result);
      } catch (loadError) {
        if (active) setError(loadError instanceof Error ? loadError.message : "Could not load products or order history.");
      }
    })();
    return () => { active = false; };
  }, [refreshOrders]);

  const productMap = useMemo(() => new Map(products.map((product) => [product.id, product])), [products]);
  const orderDiscount = Math.min(100, Math.max(0, Number(orderDiscountPercent) || 0));
  const lineSubtotal = lines.reduce((total, line) => {
    const product = productMap.get(line.productId);
    if (!product) return total;
    const price = isSale ? product.price : line.unitCost;
    return total + price * line.quantity * (1 - (isSale ? line.discountPercent : 0) / 100);
  }, 0);
  const orderDiscountAmount = isSale ? lineSubtotal * orderDiscount / 100 : 0;
  const total = Math.max(0, lineSubtotal - orderDiscountAmount);

  const addLine = () => {
    const product = productMap.get(productId);
    const count = Number(quantity);
    const lineDiscount = Number(discountPercent);
    const cost = Number(unitCost);
    if (!product || !Number.isSafeInteger(count) || count < 1
      || (isSale && (!Number.isFinite(lineDiscount) || lineDiscount < 0 || lineDiscount > 100))
      || (!isSale && (!Number.isFinite(cost) || cost < 0))) {
      setError("Choose a product and enter a valid quantity and price/discount.");
      return;
    }
    if (lines.some((line) => line.productId === product.id)) {
      setError("That product is already in this order; remove the line to change its quantity.");
      return;
    }
    setError("");
    setLines((current) => [...current, {
      productId: product.id,
      quantity: count,
      discountPercent: isSale ? lineDiscount : 0,
      unitCost: isSale ? 0 : cost,
    }]);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!lines.length) { setError("Add at least one product to the order."); return; }
    setBusy(true);
    setError("");
    setNotice("");
    try {
      const response = isSale
        ? await createSale({
          customerName: partyName.trim(),
          discountPercent: orderDiscount,
          items: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            discountPercent: line.discountPercent,
          })),
        })
        : await createPurchase({
          supplierName: partyName.trim(),
          items: lines.map((line) => ({
            productId: line.productId,
            quantity: line.quantity,
            unitCost: line.unitCost,
          })),
        });
      setNotice(`${isSale ? "Sale completed" : "Purchase received"} · ${response.reference} · $${response.total.toFixed(2)}`);
      setLines([]);
      setPartyName("");
      setOrderDiscountPercent("0");
      await Promise.all([refreshOrders(), onComplete()]);
    } catch (submitError) {
      setError(submitError instanceof Error ? submitError.message : `Could not ${isSale ? "complete the sale" : "receive the purchase"}.`);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="workspace-page" role="tabpanel">
      <div className="page-intro">
        <div>
          <p className="eyebrow">{isSale ? "CHECKOUT & REVENUE" : "GOODS RECEIVED"}</p>
          <h1>{isSale ? "Sales" : "Purchases"} <span className="product-total">{orders.length}</span></h1>
          <p className="intro-copy">
            {isSale
              ? "Record completed sales, apply discounts, and keep stock balances accurate."
              : "Receive supplier deliveries into stock with a traceable purchase record."}
          </p>
        </div>
      </div>
      {notice && <div className="notice notice-success" role="status">{notice}</div>}
      {error && <div className="notice notice-error" role="alert">{error}</div>}

      <section className="enterprise-card order-editor">
        <div className="catalog-heading">
          <div><p className="eyebrow">{isSale ? "NEW CHECKOUT" : "NEW RECEIPT"}</p><h2>{isSale ? "Complete a sale" : "Receive a purchase"}</h2></div>
          <span className="result-count">{lines.length} {lines.length === 1 ? "line" : "lines"}</span>
        </div>
        <form onSubmit={(event) => void submit(event)}>
          <div className="order-entry-grid">
            <label>{isSale ? "Customer (optional)" : "Supplier"}
              <input maxLength={160} placeholder={isSale ? "Walk-in customer" : "Supplier name"} value={partyName} onChange={(event) => setPartyName(event.target.value)} />
            </label>
            <label>Product
              <select value={productId} onChange={(event) => {
                setProductId(event.target.value);
                const product = productMap.get(event.target.value);
                if (!isSale && product) setUnitCost(product.price.toFixed(2));
              }}>
                <option value="">Select a product</option>
                {products.map((product) => (
                  <option key={product.id} value={product.id}>
                    {product.name} · {product.stock} in stock · ${product.price.toFixed(2)}
                  </option>
                ))}
              </select>
            </label>
            <label>Quantity
              <input min="1" step="1" type="number" value={quantity} onChange={(event) => setQuantity(event.target.value)} />
            </label>
            {isSale
              ? <label>Line discount %
                  <input min="0" max="100" step="0.5" type="number" value={discountPercent} onChange={(event) => setDiscountPercent(event.target.value)} />
                </label>
              : <label>Unit cost
                  <input min="0" step="0.01" type="number" value={unitCost} onChange={(event) => setUnitCost(event.target.value)} />
                </label>}
            <button className="button button-outline order-add-button" type="button" onClick={addLine}>＋ Add line</button>
          </div>

          {lines.length > 0 && (
            <div className="table-scroll order-lines">
              <table className="activity-table">
                <thead><tr><th>Product</th><th>Qty</th><th>{isSale ? "Unit price" : "Unit cost"}</th>{isSale && <th>Discount</th>}<th>Line total</th><th /></tr></thead>
                <tbody>{lines.map((line) => {
                  const product = productMap.get(line.productId)!;
                  const price = isSale ? product.price : line.unitCost;
                  const lineTotal = price * line.quantity * (1 - (isSale ? line.discountPercent : 0) / 100);
                  return <tr key={line.productId}>
                    <td><strong>{product.name}</strong><small>{product.sku || "No SKU"} · {product.stock} in stock</small></td>
                    <td>{line.quantity}</td><td>${price.toFixed(2)}</td>
                    {isSale && <td>{line.discountPercent}%</td>}
                    <td><strong>${lineTotal.toFixed(2)}</strong></td>
                    <td><button className="icon-button danger-action" type="button" onClick={() => setLines((items) => items.filter((item) => item.productId !== line.productId))}>Remove</button></td>
                  </tr>;
                })}</tbody>
              </table>
            </div>
          )}

          <div className="order-summary">
            {isSale && <label>Additional order discount %
              <input min="0" max="100" step="0.5" type="number" value={orderDiscountPercent} onChange={(event) => setOrderDiscountPercent(event.target.value)} />
            </label>}
            <div className="order-total">
              <span>{isSale && (orderDiscount > 0 || lines.some((line) => line.discountPercent > 0)) ? "Total after discounts" : "Order total"}</span>
              <strong>${total.toFixed(2)}</strong>
              {isSale && orderDiscount > 0 && <small>Order discount: −${orderDiscountAmount.toFixed(2)}</small>}
            </div>
            <button className="button button-primary" disabled={busy || lines.length === 0} type="submit">
              {busy ? "Saving…" : isSale ? "Complete sale" : "Receive purchase"} <span aria-hidden="true">→</span>
            </button>
          </div>
        </form>
      </section>

      <section className="enterprise-card">
        <div className="catalog-heading">
          <div><p className="eyebrow">TRANSACTION HISTORY</p><h2>Recent {isSale ? "sales" : "purchases"}</h2></div>
        </div>
        {orders.length === 0
          ? <p className="empty-copy">No {isSale ? "sales" : "purchases"} recorded yet.</p>
          : <div className="table-scroll"><table className="activity-table">
            <thead><tr><th>Reference</th><th>{isSale ? "Customer" : "Supplier"}</th>{isSale && <><th>Items</th><th>Discount</th></>}<th>Total</th><th>Date</th></tr></thead>
            <tbody>{orders.map((order) => {
              const sale = order as SaleSummary;
              const purchase = order as PurchaseSummary;
              return <tr key={order.id}>
                <td><strong>{order.reference}</strong></td>
                <td>{isSale ? sale.customerName || "Walk-in" : purchase.supplierName || "—"}</td>
                {isSale && <><td>{sale.itemCount}</td><td>{sale.discountPercent}% · −${sale.discountAmount.toFixed(2)}</td></>}
                <td><strong>${order.total.toFixed(2)}</strong></td>
                <td>{new Date(order.createdAtUtc).toLocaleString()}</td>
              </tr>;
            })}</tbody>
          </table></div>}
      </section>
    </section>
  );
}
