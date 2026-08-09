const previewRows = [
  {
    event: "Illustrative event A",
    selection: "Market selection",
    offered: "+120",
    fair: "+106",
    edge: "+3.8%",
  },
  {
    event: "Illustrative event B",
    selection: "Market selection",
    offered: "-105",
    fair: "-118",
    edge: "+4.1%",
  },
  {
    event: "Illustrative event C",
    selection: "No qualified edge",
    offered: "+100",
    fair: "+100",
    edge: "PASS",
  },
] as const;

const features = [
  [
    "✦",
    "+EV scanner",
    "Compare an offered price with a versioned fair-price estimate and see exactly why an opportunity qualifies—or does not.",
  ],
  [
    "⊞",
    "Odds terminal",
    "Inspect target and comparison books side by side with freshness, missing-market, and disagreement states kept visible.",
  ],
  [
    "▤",
    "Scouting evidence",
    "Review structured reports that separate provider-backed facts, deterministic calculations, and cited interpretation.",
  ],
  [
    "◔",
    "Line movement",
    "Follow immutable price history without unsupported claims about sharp action, public money, or guaranteed direction.",
  ],
  [
    "◈",
    "Decision tracking",
    "Connect a decision to the price and evidence available at that moment, then evaluate ROI and closing-line value.",
  ],
  [
    "⬢",
    "Data provenance",
    "See provider health, timestamps, verification status, and stale-data warnings wherever evidence matters.",
  ],
] as const;

const steps = [
  [
    "01",
    "Open the board",
    "Start with ranked opportunities—or a clear no-edge state when the configured rules are not met.",
  ],
  [
    "02",
    "Check the evidence",
    "Compare the price, contributing books, freshness, confidence, report context, and explicit risk flags.",
  ],
  [
    "03",
    "Record the decision",
    "Track what you chose and measure process quality over time instead of chasing a short-term hit rate.",
  ],
] as const;

const questions = [
  [
    "Is FIND THE EDGE a picks service?",
    "No. It is decision-support software that exposes price comparisons, assumptions, freshness, and reasons. You decide whether to act, and PASS is a valid result.",
  ],
  [
    "Does a positive expected value guarantee a win?",
    "No. Expected value is a long-run estimate based on available evidence. Any individual outcome can lose, and estimates can be wrong.",
  ],
  [
    "Is every sport and market live?",
    "No. Sport modules carry an explicit maturity label. Availability and data quality must be shown honestly rather than inferred from a menu item.",
  ],
  [
    "Can FIND THE EDGE place wagers?",
    "No. The product provides analytics and research. It does not accept or place sportsbook wagers.",
  ],
] as const;

function Crown({ className = "" }: { readonly className?: string }) {
  return (
    <svg
      className={className}
      width="30"
      height="24"
      viewBox="0 0 30 24"
      fill="none"
      aria-hidden="true"
    >
      <path
        d="M2 20 L5 7 L11 14 L15 4 L19 14 L25 7 L28 20 Z"
        fill="#8b5cf6"
        stroke="#c084fc"
        strokeWidth="1"
        strokeLinejoin="round"
      />
      <rect x="3" y="20" width="24" height="3" rx="1" fill="#c084fc" />
    </svg>
  );
}

export function LandingPage() {
  return (
    <div className="landing-page">
      <a className="landing-skip" href="#landing-main">
        Skip to content
      </a>
      <header className="landing-header">
        <a
          className="landing-brand"
          href="#top"
          aria-label="FIND THE EDGE home"
        >
          <Crown />
          <strong>
            FIND THE <em>EDGE</em>
          </strong>
        </a>
        <nav aria-label="Landing page">
          <a href="#features">Product</a>
          <a href="#how-it-works">How it works</a>
          <a href="#access">Access</a>
          <a href="#questions">Questions</a>
        </nav>
        <a className="landing-header-action" href="#access">
          Preview access
        </a>
      </header>

      <main id="landing-main">
        <section className="landing-hero" id="top">
          <div className="landing-hero-copy">
            <p className="landing-kicker">EVIDENCE-FIRST SPORTS INTELLIGENCE</p>
            <h1>
              Price the bet.
              <span>Don&apos;t pick the team.</span>
            </h1>
            <p className="landing-lede">
              FIND THE EDGE compares offered odds with reproducible fair-price
              estimates, keeps freshness and provenance visible, and explains
              when the disciplined answer is PASS.
            </p>
            <div className="landing-actions">
              <a className="landing-primary" href="#access">
                Explore the product
              </a>
              <a className="landing-secondary" href="#how-it-works">
                See how it works
              </a>
            </div>
            <p className="landing-note">
              Informational decision support. No wager placement. No guaranteed
              outcomes.
            </p>
          </div>

          <div
            className="landing-preview"
            aria-label="Illustrative opportunity preview"
          >
            <div className="landing-preview-bar">
              <span>+EV SCANNER</span>
              <span className="landing-preview-status">ILLUSTRATIVE DATA</span>
            </div>
            <div
              className="landing-preview-grid landing-preview-head"
              aria-hidden="true"
            >
              <span>EVENT</span>
              <span>SELECTION</span>
              <span>OFFERED</span>
              <span>FAIR</span>
              <span>EDGE</span>
            </div>
            {previewRows.map((row) => (
              <div className="landing-preview-grid" key={row.event}>
                <strong>{row.event}</strong>
                <span>{row.selection}</span>
                <span>{row.offered}</span>
                <span>{row.fair}</span>
                <b className={row.edge === "PASS" ? "is-pass" : ""}>
                  {row.edge}
                </b>
              </div>
            ))}
            <p className="landing-preview-caption">
              Example values demonstrate the interface only. They are not live
              markets or recommendations.
            </p>
          </div>
        </section>

        <section className="landing-proof" aria-label="Product principles">
          <span>DETERMINISTIC MATH</span>
          <span>IMMUTABLE ODDS EVIDENCE</span>
          <span>VISIBLE FRESHNESS</span>
          <span>VERSIONED STRATEGIES</span>
          <span>PASS IS VALID</span>
        </section>

        <section className="landing-section" id="features">
          <p className="landing-kicker">ONE DECISION SYSTEM</p>
          <h2>Evidence before persuasion</h2>
          <p className="landing-section-intro">
            The scanner, event view, report, and tracker share the same evidence
            and versioned calculations, so the reasoning can be reconstructed.
          </p>
          <div className="landing-feature-grid">
            {features.map(([icon, title, body]) => (
              <article className="landing-feature" key={title}>
                <span aria-hidden="true">{icon}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-how" id="how-it-works">
          <p className="landing-kicker">A DISCIPLINED LOOP</p>
          <h2>From board to measured decision</h2>
          <div className="landing-step-grid">
            {steps.map(([number, title, body]) => (
              <article key={number}>
                <span>{number}</span>
                <h3>{title}</h3>
                <p>{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-section landing-access" id="access">
          <div>
            <p className="landing-kicker">GATED MEMBER ACCESS</p>
            <h2>The terminal is being prepared for subscribers</h2>
            <p>
              Phone verification and billing access are not enabled in this
              environment yet. The public product preview remains available
              while account access is completed.
            </p>
          </div>
          <span className="landing-unavailable" role="status">
            ACCOUNT ACCESS COMING SOON
          </span>
        </section>

        <section className="landing-section landing-questions" id="questions">
          <p className="landing-kicker">QUESTIONS</p>
          <h2>Know what the product is—and is not</h2>
          <div>
            {questions.map(([question, answer]) => (
              <article key={question}>
                <h3>{question}</h3>
                <p>{answer}</p>
              </article>
            ))}
          </div>
        </section>

        <section className="landing-closing">
          <Crown className="landing-closing-crown" />
          <p className="landing-kicker">FIND THE EDGE</p>
          <h2>Make the price prove the play.</h2>
          <p>
            Evaluate the evidence, understand the uncertainty, and walk away
            when the thresholds are not met.
          </p>
          <a className="landing-primary" href="#top">
            Back to the board
          </a>
        </section>
      </main>

      <footer className="landing-footer">
        <div>
          <span className="landing-brand-text">
            FIND THE <em>EDGE</em>
          </span>
          <span>© 2026</span>
        </div>
        <p>
          Must be 21+. Analytics and research only. FIND THE EDGE does not
          accept wagers and is not affiliated with any sportsbook. Expected
          value is a long-run estimate, not a forecast of a single result. No
          outcome is guaranteed. Gambling problem? Call 1-800-GAMBLER.
        </p>
      </footer>
    </div>
  );
}
