import { type FormEvent, useEffect, useRef, useState } from "react";
import {
  customerImageUrl,
  getCustomerProduct,
  listCustomerProducts,
  sendCustomerChat,
} from "./api";
import type {
  CustomerAssistantReply,
  CustomerProduct,
  CustomerRoute,
} from "./types";

interface RouteState {
  page: Exclude<CustomerRoute, "stay_on_chat">;
  search: string;
  category: string;
  product: string;
}

interface CartLine {
  product: CustomerProduct;
  quantity: number;
}

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
}

function readRoute(): RouteState {
  const query = new URLSearchParams(window.location.search);
  const page = query.get("page");
  const validPages: RouteState["page"][] = [
    "product_detail", "category_listing", "cart", "checkout", "order_status",
  ];
  return {
    page: validPages.includes(page as RouteState["page"])
      ? page as RouteState["page"]
      : "category_listing",
    search: query.get("q") ?? "",
    category: query.get("category") ?? "",
    product: query.get("product") ?? "",
  };
}

function formatPrice(price: number): string {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD" }).format(price);
}

function ProductImage({ product, large = false }: { product: CustomerProduct; large?: boolean }) {
  return (
    <div className={`shop-product-image ${large ? "shop-product-image-large" : ""}`}>
      {product.imageId
        ? <img alt={product.name} loading="lazy" src={customerImageUrl(product.id, product.imageId)} />
        : <span aria-hidden="true">{product.name.slice(0, 1).toUpperCase()}</span>}
    </div>
  );
}

function App() {
  const [route, setRoute] = useState(readRoute);
  const [products, setProducts] = useState<CustomerProduct[]>([]);
  const [categories, setCategories] = useState<string[]>([]);
  const [selectedProduct, setSelectedProduct] = useState<CustomerProduct | null>(null);
  const [loadingProducts, setLoadingProducts] = useState(false);
  const [catalogError, setCatalogError] = useState("");
  const [searchText, setSearchText] = useState(route.search);
  const [cart, setCart] = useState<CartLine[]>([]);
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([
    { role: "assistant", content: "Hi! I can help you find products. What are you looking for?" },
  ]);
  const [chatText, setChatText] = useState("");
  const [chatBusy, setChatBusy] = useState(false);
  const [chatError, setChatError] = useState("");
  const [chatCollapsed, setChatCollapsed] = useState(false);
  const [cartNotice, setCartNotice] = useState("");
  const chatEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    document.title = "Stockroom | Customer Store";
    return () => {
      document.title = "Product Catalog";
    };
  }, []);

  useEffect(() => {
    const handlePopState = () => {
      const nextRoute = readRoute();
      setRoute(nextRoute);
      setSearchText(nextRoute.search);
    };
    window.addEventListener("popstate", handlePopState);
    return () => window.removeEventListener("popstate", handlePopState);
  }, []);

  useEffect(() => {
    chatEnd.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [chatMessages, chatBusy]);

  useEffect(() => {
    setChatCollapsed(["cart", "checkout", "order_status"].includes(route.page));
  }, [route.page]);

  useEffect(() => {
    const controller = new AbortController();
    if (route.page === "product_detail") {
      setLoadingProducts(true);
      setCatalogError("");
      setSelectedProduct(null);
      if (!route.product) {
        setCatalogError("Choose a product from the catalog to see its details.");
        setLoadingProducts(false);
        return () => controller.abort();
      }
      void getCustomerProduct(route.product, controller.signal)
        .then(setSelectedProduct)
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setCatalogError(error instanceof Error ? error.message : "Could not load this product.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingProducts(false);
        });
    } else if (route.page === "category_listing") {
      setLoadingProducts(true);
      setCatalogError("");
      const query = new URLSearchParams();
      if (route.search) query.set("search", route.search);
      if (route.category) query.set("category", route.category);
      void listCustomerProducts(query, controller.signal)
        .then((result) => {
          setProducts(result.items);
          setCategories(result.categories);
        })
        .catch((error: unknown) => {
          if (!controller.signal.aborted) {
            setCatalogError(error instanceof Error ? error.message : "Could not load products.");
          }
        })
        .finally(() => {
          if (!controller.signal.aborted) setLoadingProducts(false);
        });
    }
    return () => controller.abort();
  }, [route.page, route.product, route.search, route.category]);

  const navigate = (
    page: RouteState["page"],
    values: Partial<Omit<RouteState, "page">> = {},
  ) => {
    const nextRoute: RouteState = {
      page,
      search: values.search ?? "",
      category: values.category ?? "",
      product: values.product ?? "",
    };
    const query = new URLSearchParams({ page });
    if (nextRoute.search) query.set("q", nextRoute.search);
    if (nextRoute.category) query.set("category", nextRoute.category);
    if (nextRoute.product) query.set("product", nextRoute.product);
    window.history.pushState(null, "", `/shop?${query}`);
    setRoute(nextRoute);
    setSearchText(nextRoute.search);
    setCatalogError("");
  };

  const addToCart = (product: CustomerProduct) => {
    setCart((current) => {
      const existing = current.find((line) => line.product.id === product.id);
      if (existing && existing.quantity >= product.stock) {
        setCartNotice(`Only ${product.stock} ${product.name} available.`);
        return current;
      }
      setCartNotice(`${product.name} added to your cart.`);
      return existing
        ? current.map((line) => line.product.id === product.id
          ? { ...line, quantity: line.quantity + 1 }
          : line)
        : [...current, { product, quantity: 1 }];
    });
  };

  const changeQuantity = (productId: string, quantity: number) => {
    setCart((current) => current.flatMap((line) => {
      if (line.product.id !== productId) return [line];
      if (quantity < 1) return [];
      return [{ ...line, quantity: Math.min(quantity, line.product.stock) }];
    }));
  };

  const routeAssistant = (reply: CustomerAssistantReply) => {
    const { target_page: target, payload } = reply.routing_action;
    switch (target) {
      case "product_detail": {
        const product = payload.product_id_or_slug ?? payload.search_query;
        if (product) navigate("product_detail", { product });
        else navigate("category_listing", { search: payload.search_query ?? "" });
        break;
      }
      case "category_listing":
        navigate("category_listing", {
          search: payload.search_query ?? "",
          category: payload.category_name ?? "",
        });
        break;
      case "cart":
        navigate("cart");
        break;
      case "checkout":
        navigate("checkout");
        break;
      case "order_status":
        navigate("order_status");
        break;
      case "stay_on_chat":
        break;
    }
  };

  const submitChat = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const text = chatText.trim();
    if (!text || chatBusy) return;
    const userMessage: ChatMessage = { role: "user", content: text };
    const conversation = [...chatMessages, userMessage];
    setChatMessages(conversation);
    setChatText("");
    setChatBusy(true);
    setChatError("");
    try {
      const reply = await sendCustomerChat(conversation.slice(-12));
      setChatMessages((current) => [...current, {
        role: "assistant",
        content: reply.customer_facing_message,
      }]);
      routeAssistant(reply);
    } catch (error) {
      setChatError(error instanceof Error ? error.message : "The assistant could not reply.");
    } finally {
      setChatBusy(false);
    }
  };

  const submitSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    navigate("category_listing", { search: searchText.trim() });
  };

  const totalItems = cart.reduce((total, line) => total + line.quantity, 0);
  const cartTotal = cart.reduce((total, line) => total + line.product.price * line.quantity, 0);

  return (
    <div className="shop-shell">
      <header className="shop-header">
        <a className="shop-brand" href="/shop" onClick={(event) => {
          event.preventDefault();
          navigate("category_listing");
        }}>
          <span className="shop-brand-mark">S</span>
          <span><strong>stockroom</strong><small>THE CUSTOMER STORE</small></span>
        </a>
        <form className="shop-search" onSubmit={submitSearch}>
          <label className="visually-hidden" htmlFor="shop-search-input">Search products</label>
          <input id="shop-search-input" onChange={(event) => setSearchText(event.target.value)}
            placeholder="Search products, brands, categories..." value={searchText} />
          <button type="submit" aria-label="Search products">⌕</button>
        </form>
        <nav className="shop-actions" aria-label="Store navigation">
          <button className="shop-link" onClick={() => navigate("category_listing")} type="button">Shop</button>
          <button className="shop-cart-button" onClick={() => navigate("cart")} type="button">
            Cart <span>{totalItems}</span>
          </button>
          <a className="shop-admin-link" href="/">Staff sign in</a>
        </nav>
      </header>

      <main className="shop-main">
        {route.page === "category_listing" && (
          <>
            <section className="shop-hero">
              <p className="shop-eyebrow">A BETTER WAY TO DISCOVER</p>
              <h1>Find something<br /><span>you'll love.</span></h1>
              <p>Explore the collection or ask our shopping assistant to help you choose.</p>
              <button className="shop-primary-button" onClick={() => document.getElementById("shop-products")?.scrollIntoView({ behavior: "smooth" })} type="button">Explore products <span>↓</span></button>
              <div className="shop-hero-stamp" aria-hidden="true">CURATED<br />FOR YOU</div>
            </section>
            <div className="shop-catalog" id="shop-products">
              <aside className="shop-categories">
                <p className="shop-eyebrow">COLLECTION</p>
                <button className={!route.category ? "shop-category-active" : ""}
                  onClick={() => navigate("category_listing", { search: route.search })} type="button">All products</button>
                {categories.map((category) => (
                  <button className={route.category === category ? "shop-category-active" : ""}
                    key={category} onClick={() => navigate("category_listing", { category })}
                    type="button">{category}</button>
                ))}
              </aside>
              <section className="shop-results" aria-live="polite">
                <div className="shop-results-heading">
                  <div>
                    <p className="shop-eyebrow">{route.category || "THE COLLECTION"}</p>
                    <h2>{route.search ? `Results for "${route.search}"` : route.category || "Shop all products"}</h2>
                  </div>
                  <span>{products.length} products</span>
                </div>
                {catalogError && <p className="shop-notice shop-error">{catalogError}</p>}
                {loadingProducts
                  ? <p className="shop-empty">Loading the collection…</p>
                  : products.length
                    ? <div className="shop-product-grid">{products.map((product) => (
                      <article className="shop-product-card" key={product.id}>
                        <button className="shop-product-open" onClick={() => navigate("product_detail", { product: product.id })}
                          type="button" aria-label={`View ${product.name}`}>
                          <ProductImage product={product} />
                          <span className="shop-product-category">{product.category}</span>
                          <strong>{product.name}</strong>
                          {product.brand && <small>{product.brand}</small>}
                        </button>
                        <div className="shop-product-footer">
                          <b>{formatPrice(product.price)}</b>
                          <button aria-label={`Add ${product.name} to cart`} onClick={() => addToCart(product)} type="button">+</button>
                        </div>
                      </article>
                    ))}</div>
                    : !catalogError && <p className="shop-empty">No products match this search. Try another name or category.</p>}
              </section>
            </div>
          </>
        )}

        {route.page === "product_detail" && (
          <section className="shop-detail">
            {loadingProducts && <p className="shop-empty">Loading product…</p>}
            {catalogError && <div className="shop-empty"><p>{catalogError}</p><button className="shop-primary-button" onClick={() => navigate("category_listing")} type="button">Browse products</button></div>}
            {selectedProduct && <>
              <button className="shop-back-link" onClick={() => navigate("category_listing")} type="button">← Back to collection</button>
              <div className="shop-detail-layout">
                <ProductImage large product={selectedProduct} />
                <div className="shop-detail-copy">
                  <p className="shop-eyebrow">{selectedProduct.category}{selectedProduct.brand ? ` / ${selectedProduct.brand}` : ""}</p>
                  <h1>{selectedProduct.name}</h1>
                  <strong className="shop-detail-price">{formatPrice(selectedProduct.price)}</strong>
                  <p>{selectedProduct.description || "A thoughtful addition to your collection."}</p>
                  <p className="shop-stock">{selectedProduct.stock} in stock</p>
                  <button className="shop-primary-button" onClick={() => addToCart(selectedProduct)} type="button">Add to cart</button>
                  {cartNotice && <p className="shop-notice" role="status">{cartNotice}</p>}
                  {selectedProduct.sku && <small className="shop-sku">SKU {selectedProduct.sku}</small>}
                </div>
              </div>
            </>}
          </section>
        )}

        {route.page === "cart" && (
          <section className="shop-simple-page">
            <p className="shop-eyebrow">YOUR SELECTION</p>
            <h1>Your cart</h1>
            {!cart.length
              ? <div className="shop-empty"><p>Your cart is waiting for something good.</p><button className="shop-primary-button" onClick={() => navigate("category_listing")} type="button">Explore products</button></div>
              : <div className="shop-cart-layout">
                <div className="shop-cart-lines">{cart.map(({ product, quantity }) => (
                  <article className="shop-cart-line" key={product.id}>
                    <ProductImage product={product} />
                    <div><strong>{product.name}</strong><small>{formatPrice(product.price)} each</small></div>
                    <label>Qty <input aria-label={`Quantity of ${product.name}`} max={product.stock} min="1"
                      onChange={(event) => changeQuantity(product.id, Number(event.target.value))}
                      type="number" value={quantity} /></label>
                    <b>{formatPrice(product.price * quantity)}</b>
                    <button aria-label={`Remove ${product.name}`} onClick={() => changeQuantity(product.id, 0)} type="button">×</button>
                  </article>
                ))}</div>
                <aside className="shop-order-summary">
                  <p>Subtotal <strong>{formatPrice(cartTotal)}</strong></p>
                  <small>Shipping and taxes are calculated at checkout.</small>
                  <button className="shop-primary-button" onClick={() => navigate("checkout")} type="button">Continue to checkout</button>
                </aside>
              </div>}
          </section>
        )}

        {route.page === "checkout" && (
          <section className="shop-simple-page">
            <p className="shop-eyebrow">ALMOST THERE</p>
            <h1>Checkout</h1>
            <div className="shop-preview-card">
              <strong>Online checkout is not enabled yet.</strong>
              <p>Your cart is saved while you browse, but this preview does not accept payment or place an order.</p>
              {cart.length > 0 && <p>{totalItems} items · {formatPrice(cartTotal)}</p>}
              <button className="shop-primary-button" onClick={() => navigate("cart")} type="button">Return to cart</button>
            </div>
          </section>
        )}

        {route.page === "order_status" && (
          <section className="shop-simple-page">
            <p className="shop-eyebrow">ORDER SUPPORT</p>
            <h1>Order status</h1>
            <div className="shop-preview-card">
              <strong>There are no customer orders to track here yet.</strong>
              <p>Order lookup will be available when customer checkout and order accounts are connected.</p>
              <button className="shop-primary-button" onClick={() => navigate("category_listing")} type="button">Continue shopping</button>
            </div>
          </section>
        )}
      </main>

      {cartNotice && route.page === "category_listing" && <div className="shop-toast" role="status">{cartNotice}</div>}

      <aside className={`shop-chat ${chatCollapsed ? "shop-chat-collapsed" : ""}`} aria-label="Shopping assistant">
        <div className="shop-chat-heading">
          <span className="shop-chat-avatar" aria-hidden="true">✦</span>
          <span><strong>Shopping assistant</strong><small>PRODUCT DISCOVERY</small></span>
          <i aria-label="Online" />
          <button className="shop-chat-toggle" aria-expanded={!chatCollapsed}
            aria-label={chatCollapsed ? "Open shopping assistant" : "Minimize shopping assistant"}
            onClick={() => setChatCollapsed((collapsed) => !collapsed)} type="button">
            {chatCollapsed ? "↑" : "−"}
          </button>
        </div>
        {!chatCollapsed && <>
          <div className="shop-chat-messages" aria-live="polite" aria-relevant="additions text">
            {chatMessages.map((message, index) => (
              <div className={`shop-chat-message shop-chat-${message.role}`} key={`${index}-${message.role}`}>
                {message.content}
              </div>
            ))}
            {chatBusy && <div className="shop-chat-message shop-chat-assistant">Let me find that for you…</div>}
            <div ref={chatEnd} />
          </div>
          {chatError && <p className="shop-chat-error" role="alert">{chatError}</p>}
          <form className="shop-chat-form" onSubmit={(event) => void submitChat(event)}>
            <label className="visually-hidden" htmlFor="shop-chat-input">Message the shopping assistant</label>
            <input id="shop-chat-input" maxLength={1000} onChange={(event) => setChatText(event.target.value)}
              placeholder="Ask about a product..." value={chatText} />
            <button aria-label="Send message" disabled={chatBusy || !chatText.trim()} type="submit">↑</button>
          </form>
          <small className="shop-chat-caption">AI suggestions can make mistakes. Check product details before ordering.</small>
        </>}
      </aside>
      <footer className="shop-footer"><span>STOCKROOM · CUSTOMER STORE</span><span>Thoughtful finds, made simple.</span></footer>
    </div>
  );
}

export default App;
