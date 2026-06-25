// Razorpay type declarations
declare global {
  interface Window {
    Razorpay: new (options: RazorpayOptions) => RazorpayInstance;
  }
}

interface RazorpayOptions {
  key: string;
  amount: number;           // in paise (1 INR = 100 paise)
  currency: string;
  name: string;
  description?: string;
  image?: string;
  order_id: string;
  prefill?: {
    name?: string;
    email?: string;
    contact?: string;
  };
  notes?: Record<string, string>;
  theme?: {
    color?: string;
  };
  handler: (response: RazorpayPaymentResponse) => void;
  modal?: {
    ondismiss?: () => void;
    confirm_close?: boolean;
  };
}

interface RazorpayPaymentResponse {
  razorpay_payment_id: string;
  razorpay_order_id: string;
  razorpay_signature: string;
}

interface RazorpayInstance {
  open(): void;
  close(): void;
  on(event: string, callback: (...args: unknown[]) => void): void;
}

interface OrderCreateRequest {
  amount: number;   // in paise
  currency: string;
  receipt: string;
  notes?: Record<string, string>;
}

interface OrderCreateResponse {
  id: string;
  entity: string;
  amount: number;
  amount_paid: number;
  amount_due: number;
  currency: string;
  receipt: string;
  status: string;
  created_at: number;
}

interface PaymentConfig {
  keyId: string;
  businessName: string;
  businessLogo?: string;
  themeColor?: string;
  createOrderEndpoint: string;   // your backend endpoint
  verifyPaymentEndpoint: string; // your backend endpoint
}

// ── Payment state ────────────────────────────────────────────────────────────

type PaymentStatus = "idle" | "loading" | "success" | "failed";

interface PaymentState {
  status: PaymentStatus;
  orderId: string | null;
  paymentId: string | null;
  error: string | null;
}

// ── RazorpayCheckout class ────────────────────────────────────────────────────

export class RazorpayCheckout {
  private config: PaymentConfig;
  private state: PaymentState = {
    status: "idle",
    orderId: null,
    paymentId: null,
    error: null,
  };
  private onStateChange?: (state: PaymentState) => void;

  constructor(config: PaymentConfig) {
    this.config = config;
  }

  setOnStateChange(cb: (state: PaymentState) => void): void {
    this.onStateChange = cb;
  }

  private setState(patch: Partial<PaymentState>): void {
    this.state = { ...this.state, ...patch };
    this.onStateChange?.(this.state);
  }

  getState(): PaymentState {
    return { ...this.state };
  }

  // Create an order via your backend and open the Razorpay modal
  async initiatePayment(params: {
    amount: number;       // in INR (will be converted to paise)
    currency?: string;
    receipt?: string;
    prefill?: RazorpayOptions["prefill"];
    notes?: Record<string, string>;
    description?: string;
  }): Promise<void> {
    this.setState({ status: "loading", error: null });

    try {
      await this.ensureRazorpayLoaded();

      const amountInPaise = Math.round(params.amount * 100);
      const order = await this.createOrder({
        amount: amountInPaise,
        currency: params.currency ?? "INR",
        receipt: params.receipt ?? `rcpt_${Date.now()}`,
        notes: params.notes,
      });

      this.setState({ orderId: order.id });

      await new Promise<void>((resolve, reject) => {
        const rzp = new window.Razorpay({
          key: this.config.keyId,
          amount: order.amount,
          currency: order.currency,
          name: this.config.businessName,
          description: params.description,
          image: this.config.businessLogo,
          order_id: order.id,
          prefill: params.prefill,
          notes: params.notes,
          theme: { color: this.config.themeColor ?? "#00ff9f" },
          handler: async (response) => {
            try {
              await this.verifyPayment(response);
              this.setState({ status: "success", paymentId: response.razorpay_payment_id });
              resolve();
            } catch (err) {
              const msg = err instanceof Error ? err.message : "Verification failed";
              this.setState({ status: "failed", error: msg });
              reject(new Error(msg));
            }
          },
          modal: {
            ondismiss: () => {
              this.setState({ status: "idle" });
              reject(new Error("Payment dismissed by user"));
            },
            confirm_close: true,
          },
        });
        rzp.open();
      });
    } catch (err) {
      if (this.state.status !== "idle") {
        const msg = err instanceof Error ? err.message : "Payment failed";
        this.setState({ status: "failed", error: msg });
      }
      throw err;
    }
  }

  private async createOrder(req: OrderCreateRequest): Promise<OrderCreateResponse> {
    const res = await fetch(this.config.createOrderEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Order creation failed: ${text}`);
    }
    return res.json() as Promise<OrderCreateResponse>;
  }

  private async verifyPayment(response: RazorpayPaymentResponse): Promise<void> {
    const res = await fetch(this.config.verifyPaymentEndpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(response),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`Payment verification failed: ${text}`);
    }
  }

  private ensureRazorpayLoaded(): Promise<void> {
    if (window.Razorpay) return Promise.resolve();

    return new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://checkout.razorpay.com/v1/checkout.js";
      script.onload = () => resolve();
      script.onerror = () => reject(new Error("Failed to load Razorpay SDK"));
      document.head.appendChild(script);
    });
  }
}

// ── UI helpers ────────────────────────────────────────────────────────────────

function renderStatus(state: PaymentState): void {
  const el = document.getElementById("payment-status");
  const btn = document.getElementById("pay-btn") as HTMLButtonElement | null;
  if (!el) return;

  const messages: Record<PaymentStatus, string> = {
    idle: "",
    loading: "Processing…",
    success: `Payment successful! ID: ${state.paymentId ?? ""}`,
    failed: `Payment failed: ${state.error ?? "Unknown error"}`,
  };

  const classes: Record<PaymentStatus, string> = {
    idle: "",
    loading: "status-loading",
    success: "status-success",
    failed: "status-failed",
  };

  el.textContent = messages[state.status];
  el.className = `status-msg ${classes[state.status]}`;

  if (btn) btn.disabled = state.status === "loading";
}

// ── Bootstrap ─────────────────────────────────────────────────────────────────

document.addEventListener("DOMContentLoaded", () => {
  const checkout = new RazorpayCheckout({
    keyId: (document.getElementById("rzp-key") as HTMLInputElement)?.value ?? "rzp_test_YOUR_KEY_ID",
    businessName: "Your Business",
    themeColor: "#00ff9f",
    createOrderEndpoint: "/api/orders",
    verifyPaymentEndpoint: "/api/verify-payment",
  });

  checkout.setOnStateChange(renderStatus);

  const form = document.getElementById("payment-form") as HTMLFormElement | null;
  form?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const data = new FormData(form);

    const amount = parseFloat(data.get("amount") as string);
    const name = data.get("name") as string;
    const email = data.get("email") as string;
    const contact = data.get("contact") as string;

    try {
      await checkout.initiatePayment({
        amount,
        description: "Order Payment",
        prefill: { name, email, contact },
      });
    } catch {
      // state already updated via onStateChange
    }
  });
});
