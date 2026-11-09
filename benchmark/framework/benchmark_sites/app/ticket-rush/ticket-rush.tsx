"use client";

import { Checkbox } from "@base-ui/react/checkbox";
import { Field } from "@base-ui/react/field";
import {
  type ChangeEvent,
  type FormEvent,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  deriveSalePhase,
  formatCountdown,
  formatCurrency,
  millisecondsLeftToClaim,
  millisecondsUntilSale,
  priceSummary,
  relativeSaturdayPerformances,
  SALE_DELAY_MS,
  TICKET_TIERS,
  type TicketTierId,
} from "./ticket-state";

type Outcome = "idle" | "confirmed" | "missed";
type AttemptOrigin = "first-page-load" | "retry-after-refresh";

interface BuyerDetails {
  firstName: string;
  lastName: string;
  email: string;
  phone: string;
  postalCode: string;
}

const INITIAL_BUYER: BuyerDetails = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  postalCode: "",
};

interface TicketRushProps {
  referenceTimeMs: number;
}

function Checkmark() {
  return <span aria-hidden="true">✓</span>;
}

export function TicketRush({ referenceTimeMs }: TicketRushProps) {
  const performanceOptions = useMemo(
    () => relativeSaturdayPerformances(new Date(referenceTimeMs)),
    [referenceTimeMs],
  );
  const [navigationStartedAt, setNavigationStartedAt] = useState<number | null>(
    null,
  );
  const [now, setNow] = useState<number | null>(null);
  const [performanceId, setPerformanceId] = useState(
    performanceOptions[0].value,
  );
  const [tierId, setTierId] = useState<TicketTierId>("upper");
  const [quantity, setQuantity] = useState(1);
  const [buyer, setBuyer] = useState<BuyerDetails>(INITIAL_BUYER);
  const [termsAccepted, setTermsAccepted] = useState(false);
  const [outcome, setOutcome] = useState<Outcome>("idle");
  const [attemptOrigin, setAttemptOrigin] =
    useState<AttemptOrigin>("first-page-load");
  const formRef = useRef<HTMLFormElement>(null);

  useEffect(() => {
    const startedAt = performance.timeOrigin;
    const [navigationEntry] = performance.getEntriesByType(
      "navigation",
    ) as PerformanceNavigationTiming[];
    let timeoutId = 0;
    let stopped = false;

    const tick = () => {
      if (stopped) {
        return;
      }

      const currentTime = Date.now();
      setNow(currentTime);

      const phase = deriveSalePhase(currentTime, startedAt);
      const nextTickMs =
        phase === "scheduled" ? 100 : phase === "live" ? 20 : 1_000;
      timeoutId = window.setTimeout(tick, nextTickMs);
    };

    const initialize = () => {
      if (stopped) {
        return;
      }
      setAttemptOrigin(
        navigationEntry?.type === "reload"
          ? "retry-after-refresh"
          : "first-page-load",
      );
      setNavigationStartedAt(startedAt);
      tick();
    };

    timeoutId = window.setTimeout(initialize, 0);
    return () => {
      stopped = true;
      window.clearTimeout(timeoutId);
    };
  }, []);

  const phase =
    now === null || navigationStartedAt === null
      ? "scheduled"
      : deriveSalePhase(now, navigationStartedAt);
  const visibleOutcome =
    outcome === "confirmed"
      ? "confirmed"
      : outcome === "missed" || phase === "missed"
        ? "missed"
        : "idle";
  const selectedTier =
    TICKET_TIERS.find((tier) => tier.id === tierId) ?? TICKET_TIERS[0];
  const selectedPerformance =
    performanceOptions.find((option) => option.value === performanceId) ??
    performanceOptions[0];
  const primaryPerformance = performanceOptions[0];
  const totals = useMemo(
    () => priceSummary(tierId, quantity),
    [quantity, tierId],
  );
  const isBuyerComplete = Object.values(buyer).every(
    (value) => value.trim().length > 0,
  );
  const isReady = isBuyerComplete && termsAccepted;
  const saleCountdown =
    now === null || navigationStartedAt === null
      ? SALE_DELAY_MS
      : millisecondsUntilSale(now, navigationStartedAt);
  const claimCountdown =
    now === null || navigationStartedAt === null
      ? 0
      : millisecondsLeftToClaim(now, navigationStartedAt);

  function updateBuyer(
    field: keyof BuyerDetails,
    event: ChangeEvent<HTMLInputElement>,
  ) {
    const value = event.currentTarget.value;
    setBuyer((currentBuyer) => ({ ...currentBuyer, [field]: value }));
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();

    if (!formRef.current?.reportValidity() || !termsAccepted) {
      return;
    }

    if (navigationStartedAt === null) {
      return;
    }

    const clickTime = Date.now();
    const clickPhase = deriveSalePhase(clickTime, navigationStartedAt);
    if (clickPhase === "live") {
      setOutcome("confirmed");
      return;
    }

    if (clickPhase === "missed") {
      setOutcome("missed");
    }
  }

  const actionDisabled =
    visibleOutcome !== "idle" || phase !== "live" || !isReady;

  return (
    <div
      className="site-shell"
      data-sale-phase={phase}
      data-outcome={visibleOutcome}
      data-attempt-origin={attemptOrigin}
    >
      <a className="skip-link" href="#ticket-form">
        Skip to ticket form
      </a>

      <header className="masthead">
        <a className="brand" href="#top" aria-label="Lumen Tickets home">
          <span>LUMEN</span>
          <span>/TICKETS</span>
        </a>
        <nav aria-label="Primary navigation">
          <a href="#details">Concerts</a>
          <a href="#venue">Venues</a>
          <a href="#help">Help</a>
        </nav>
        <p className="official-sale">
          <span aria-hidden="true" />
          Official event sale
        </p>
      </header>

      <main id="top">
        <section className="hero" aria-labelledby="event-title">
          <div className="hero-copy">
            <p className="eyebrow">
              LIVE {primaryPerformance.year} / CHICAGO, IL
            </p>
            <h1 id="event-title">
              <span>NORTHSTAR</span>
              <span>AFTERGLOW</span>
              <span>TOUR</span>
            </h1>
            <p className="hero-summary">
              A collision of light, rhythm, and the songs that made the world
              feel close again.
            </p>
          </div>

          <div className="event-poster" aria-label="Northstar tour poster">
            <div className="poster-index">
              NS/{String(primaryPerformance.year).slice(-2)}
            </div>
            <div className="poster-orbit poster-orbit-one" />
            <div className="poster-orbit poster-orbit-two" />
            <div className="poster-core">N</div>
            <p>
              <span>{primaryPerformance.posterLabel}</span>
              <span>CHICAGO</span>
              <span>{primaryPerformance.year}</span>
            </p>
          </div>

          <dl className="event-facts" id="details">
            <div>
              <dt>Date</dt>
              <dd>{primaryPerformance.shortLabel}</dd>
            </div>
            <div id="venue">
              <dt>Venue</dt>
              <dd>Lakefront Arena</dd>
            </div>
            <div>
              <dt>Doors / Show</dt>
              <dd>6:30 PM / 8:00 PM</dd>
            </div>
            <div>
              <dt>Location</dt>
              <dd>Chicago, Illinois</dd>
            </div>
          </dl>
        </section>

        <section className="sale-section" aria-labelledby="sale-heading">
          <div className="section-heading">
            <div>
              <p className="section-number">01 / PUBLIC ON-SALE</p>
              <h2 id="sale-heading">Build your order. Beat the clock.</h2>
            </div>
            <p className="capacity-note">LIMIT 2 TICKETS / ORDER</p>
          </div>

          <div className="sale-grid">
            <form
              id="ticket-form"
              ref={formRef}
              className="ticket-form"
              onSubmit={handleSubmit}
            >
              <fieldset disabled={visibleOutcome === "confirmed"}>
                <legend>
                  <span>01</span>
                  Your tickets
                </legend>

                <div className="form-grid form-grid-ticket">
                  <label className="native-field">
                    <span>Performance</span>
                    <select
                      name="performance"
                      value={performanceId}
                      onChange={(event) =>
                        setPerformanceId(event.currentTarget.value)
                      }
                    >
                      {performanceOptions.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="native-field">
                    <span>Ticket section</span>
                    <select
                      name="ticketTier"
                      value={tierId}
                      onChange={(event) =>
                        setTierId(event.currentTarget.value as TicketTierId)
                      }
                    >
                      {TICKET_TIERS.map((tier) => (
                        <option key={tier.id} value={tier.id}>
                          {tier.label} — {formatCurrency(tier.price)}
                        </option>
                      ))}
                    </select>
                  </label>

                  <label className="native-field">
                    <span>Quantity</span>
                    <select
                      name="quantity"
                      value={quantity}
                      onChange={(event) =>
                        setQuantity(Number(event.currentTarget.value))
                      }
                    >
                      <option value={1}>1 ticket</option>
                      <option value={2}>2 tickets</option>
                    </select>
                  </label>
                </div>
              </fieldset>

              <fieldset disabled={visibleOutcome === "confirmed"}>
                <legend>
                  <span>02</span>
                  Buyer information
                </legend>

                <div className="form-grid form-grid-buyer">
                  <Field.Root className="base-field" name="firstName">
                    <Field.Label>First name</Field.Label>
                    <Field.Control
                      required
                      autoComplete="given-name"
                      value={buyer.firstName}
                      onChange={(event) => updateBuyer("firstName", event)}
                    />
                    <Field.Error match="valueMissing">
                      Enter your first name.
                    </Field.Error>
                  </Field.Root>

                  <Field.Root className="base-field" name="lastName">
                    <Field.Label>Last name</Field.Label>
                    <Field.Control
                      required
                      autoComplete="family-name"
                      value={buyer.lastName}
                      onChange={(event) => updateBuyer("lastName", event)}
                    />
                    <Field.Error match="valueMissing">
                      Enter your last name.
                    </Field.Error>
                  </Field.Root>

                  <Field.Root className="base-field" name="email">
                    <Field.Label>Email address</Field.Label>
                    <Field.Control
                      required
                      type="email"
                      autoComplete="email"
                      value={buyer.email}
                      onChange={(event) => updateBuyer("email", event)}
                    />
                    <Field.Error match="valueMissing">
                      Enter your email address.
                    </Field.Error>
                    <Field.Error match="typeMismatch">
                      Use a valid email address.
                    </Field.Error>
                  </Field.Root>

                  <Field.Root className="base-field" name="phone">
                    <Field.Label>Mobile number</Field.Label>
                    <Field.Control
                      required
                      type="tel"
                      autoComplete="tel"
                      placeholder="(312) 555-0123"
                      value={buyer.phone}
                      onChange={(event) => updateBuyer("phone", event)}
                    />
                    <Field.Error match="valueMissing">
                      Enter your mobile number.
                    </Field.Error>
                  </Field.Root>

                  <Field.Root className="base-field" name="postalCode">
                    <Field.Label>Billing ZIP code</Field.Label>
                    <Field.Control
                      required
                      inputMode="numeric"
                      autoComplete="postal-code"
                      pattern="[0-9]{5}"
                      placeholder="60601"
                      value={buyer.postalCode}
                      onChange={(event) => updateBuyer("postalCode", event)}
                    />
                    <Field.Error match="valueMissing">
                      Enter your ZIP code.
                    </Field.Error>
                    <Field.Error match="patternMismatch">
                      Use a five-digit U.S. ZIP code.
                    </Field.Error>
                  </Field.Root>
                </div>
              </fieldset>

              <label className="terms-row">
                <Checkbox.Root
                  className="base-checkbox"
                  name="terms"
                  required
                  checked={termsAccepted}
                  disabled={visibleOutcome === "confirmed"}
                  onCheckedChange={setTermsAccepted}
                >
                  <Checkbox.Indicator className="checkbox-indicator">
                    <Checkmark />
                  </Checkbox.Indicator>
                </Checkbox.Root>
                <span>
                  I agree to the ticket limit, refund policy, and venue terms.
                </span>
              </label>

              <div
                className="sale-callout"
                role="status"
                aria-live="assertive"
                data-testid="sale-status"
              >
                {phase === "scheduled" && visibleOutcome === "idle" ? (
                  <>
                    <div>
                      <p>Tickets release in</p>
                      <output aria-label="Time until ticket sale">
                        {formatCountdown(saleCountdown)}
                      </output>
                    </div>
                    <p className="readiness">
                      <span data-ready={isReady}>
                        {isReady ? "ORDER READY" : "COMPLETE THE FORM"}
                      </span>
                      The claim button stays locked until the public sale.
                    </p>
                  </>
                ) : null}

                {phase === "live" && visibleOutcome === "idle" ? (
                  <>
                    <div className="live-copy">
                      <p>Tickets are live</p>
                      <strong>CLAIM NOW</strong>
                    </div>
                    <output aria-label="Time left to claim tickets">
                      {formatCountdown(claimCountdown)}
                    </output>
                  </>
                ) : null}

                {visibleOutcome === "missed" ? (
                  <div className="missed-copy">
                    <p>Drop closed</p>
                    <strong>These tickets are no longer available.</strong>
                    <span>
                      This was your only attempt. Do not refresh or try again.
                    </span>
                  </div>
                ) : null}

                {visibleOutcome === "confirmed" ? (
                  <div className="confirmed-copy">
                    <p>Order confirmed</p>
                    <strong>YOU GOT THE TICKETS.</strong>
                    <span>A reservation receipt is shown beside the form.</span>
                  </div>
                ) : null}
              </div>

              <button
                className="claim-button"
                type="submit"
                disabled={actionDisabled}
                data-testid="claim-tickets"
              >
                <span>
                  {visibleOutcome === "confirmed"
                    ? "TICKETS SECURED"
                    : visibleOutcome === "missed"
                      ? "DROP CLOSED"
                      : phase === "live"
                        ? "CLAIM TICKETS"
                        : "WAITING FOR SALE"}
                </span>
                <span aria-hidden="true">↗</span>
              </button>
            </form>

            <aside className="order-panel" aria-labelledby="order-summary-title">
              {visibleOutcome === "confirmed" ? (
                <div
                  className="receipt"
                  data-testid="confirmation-receipt"
                  aria-live="polite"
                >
                  <div className="receipt-mark" aria-hidden="true">
                    ✓
                  </div>
                  <p className="receipt-kicker">Reservation confirmed</p>
                  <h3 id="order-summary-title">You&apos;re in.</h3>
                  <p className="receipt-code-label">Confirmation</p>
                  <p className="receipt-code">
                    {selectedPerformance.confirmationCode}
                  </p>
                  <dl className="receipt-details">
                    <div>
                      <dt>Event</dt>
                      <dd>Northstar — Afterglow Tour</dd>
                    </div>
                    <div>
                      <dt>Performance</dt>
                      <dd>{selectedPerformance.label}</dd>
                    </div>
                    <div>
                      <dt>Tickets</dt>
                      <dd>
                        {quantity} × {selectedTier.label}
                      </dd>
                    </div>
                    <div>
                      <dt>Buyer</dt>
                      <dd>
                        {buyer.firstName} {buyer.lastName}
                      </dd>
                    </div>
                    <div>
                      <dt>Total</dt>
                      <dd>{formatCurrency(totals.total)}</dd>
                    </div>
                    <div>
                      <dt>Attempt</dt>
                      <dd>
                        {attemptOrigin === "first-page-load"
                          ? "First attempt · no refresh"
                          : "Retry after page refresh"}
                      </dd>
                    </div>
                  </dl>
                  <p className="receipt-note">
                    Your seats are reserved for this benchmark checkout. No
                    payment was collected.
                  </p>
                </div>
              ) : (
                <>
                  <div className="summary-topline">
                    <p className="section-number">ORDER SUMMARY</p>
                    <span>USD</span>
                  </div>
                  <h3 id="order-summary-title">Northstar</h3>
                  <p className="summary-tour">Afterglow Tour · Chicago</p>

                  <dl className="summary-selection">
                    <div>
                      <dt>Performance</dt>
                      <dd>{selectedPerformance.label}</dd>
                    </div>
                    <div>
                      <dt>Section</dt>
                      <dd>{selectedTier.label}</dd>
                    </div>
                    <div>
                      <dt>Quantity</dt>
                      <dd>{quantity}</dd>
                    </div>
                    <div>
                      <dt>Attempt</dt>
                      <dd>
                        {attemptOrigin === "first-page-load"
                          ? "First attempt · no refresh"
                          : "Retry after page refresh"}
                      </dd>
                    </div>
                  </dl>

                  <dl className="price-breakdown">
                    <div>
                      <dt>Ticket value</dt>
                      <dd>{formatCurrency(totals.faceValue)}</dd>
                    </div>
                    <div>
                      <dt>Service fees</dt>
                      <dd>{formatCurrency(totals.serviceFees)}</dd>
                    </div>
                    <div>
                      <dt>Venue fees</dt>
                      <dd>{formatCurrency(totals.venueFees)}</dd>
                    </div>
                    <div>
                      <dt>Order processing</dt>
                      <dd>{formatCurrency(totals.orderFee)}</dd>
                    </div>
                    <div className="price-total">
                      <dt>Total</dt>
                      <dd>{formatCurrency(totals.total)}</dd>
                    </div>
                  </dl>

                  <div className="buyer-preview">
                    <p>Prepared for</p>
                    <strong>
                      {isBuyerComplete
                        ? `${buyer.firstName} ${buyer.lastName}`
                        : "Add buyer information"}
                    </strong>
                    <span>{buyer.email || "Email receipt destination"}</span>
                  </div>
                </>
              )}
            </aside>
          </div>
        </section>

        <section className="trust-strip" id="help" aria-label="Purchase details">
          <article>
            <p>01</p>
            <h2>Official inventory</h2>
            <span>Tickets are issued directly for this event.</span>
          </article>
          <article>
            <p>02</p>
            <h2>Transparent total</h2>
            <span>Every fee is shown before the sale opens.</span>
          </article>
          <article>
            <p>03</p>
            <h2>No payment collected</h2>
            <span>This benchmark checkout creates a reservation only.</span>
          </article>
        </section>
      </main>

      <footer>
        <p>LUMEN / TICKETS © {primaryPerformance.year}</p>
        <p>Benchmark event sale · United States</p>
      </footer>
    </div>
  );
}
