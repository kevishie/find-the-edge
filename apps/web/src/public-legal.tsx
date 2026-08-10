import { Link } from "@tanstack/react-router";

const EFFECTIVE_DATE = "August 9, 2026";
const CONTACT_URL = "https://x.com/kevishie";

function LegalContact() {
  return (
    <a href={CONTACT_URL} target="_blank" rel="noreferrer">
      x.com/kevishie
    </a>
  );
}

function TermsOfUse() {
  return (
    <>
      <section id="acceptance">
        <h2>1. Acceptance of these Terms</h2>
        <p>
          These Terms of Use (the “Terms”) are a binding agreement between you
          and the owner and operator of Find The Edge (“Find The Edge,” “we,”
          “us,” or “our”). They govern your access to and use of our websites,
          applications, analytics, reports, data displays, alerts, and related
          services (collectively, the “Service”). By accessing the Service,
          creating an account, or purchasing a subscription, you agree to these
          Terms and our Privacy Policy. If you do not agree, do not use the
          Service.
        </p>
      </section>

      <section id="eligibility">
        <h2>2. Eligibility and lawful use</h2>
        <p>
          You must be at least 21 years old and legally capable of entering a
          contract to use the Service. You may use the Service only where doing
          so is lawful. Sports wagering laws vary by jurisdiction, and you are
          solely responsible for knowing and complying with all laws, rules,
          sportsbook terms, and geographic restrictions that apply to you.
          Access to the Service does not establish that wagering is legal in
          your location.
        </p>
      </section>

      <section id="service">
        <h2>3. Analytics service only</h2>
        <p>
          Find The Edge is an independent information and analytics service. We
          are not a sportsbook, casino, gambling operator, broker, investment
          adviser, fiduciary, or payment institution. We do not accept, place,
          transmit, settle, or custody wagers or wagering funds. We are not
          affiliated with or endorsed by any sportsbook unless expressly stated
          in writing.
        </p>
      </section>

      <section id="no-advice">
        <h2>4. No advice, promise, or guaranteed outcome</h2>
        <p>
          The Service is provided for general informational and research
          purposes. Odds, probabilities, expected value, confidence scores,
          projections, model outputs, and recommendations are estimates—not
          facts, promises, or predictions of any individual result. Historical
          performance does not guarantee future results. Data may be delayed,
          incomplete, inaccurate, unavailable, or changed without notice.
        </p>
        <p>
          You make every wagering and financial decision independently and at
          your own risk. You are solely responsible for verifying prices,
          limits, market rules, lineups, injuries, settlement terms, and other
          information with the applicable sportsbook before acting.
        </p>
      </section>

      <section id="accounts">
        <h2>5. Accounts and security</h2>
        <p>
          You must provide accurate, current information and maintain control of
          your phone number, one-time passcodes, devices, and account sessions.
          You may not share, sell, transfer, or allow another person to use your
          account. You are responsible for activity occurring through your
          account unless prohibited by law. Notify us promptly through our
          contact channel if you suspect unauthorized access. We may require
          identity or account verification and may refuse, suspend, or terminate
          access to protect the Service or its users.
        </p>
      </section>

      <section id="subscriptions">
        <h2>6. Trials, subscriptions, billing, and cancellation</h2>
        <p>
          Paid plans, billing intervals, trial periods, and prices are shown at
          checkout. Unless stated otherwise, a free trial automatically converts
          to the selected paid subscription when the trial ends, and your
          subscription automatically renews at the disclosed interval until you
          cancel. You authorize us and our payment processor, Stripe, to charge
          the payment method you provide for recurring fees, applicable taxes,
          and other disclosed charges.
        </p>
        <p>
          You may cancel through the account or billing controls made available
          with the Service. Cancellation stops future renewal charges but does
          not ordinarily provide a refund or credit for a partially used period.
          Fees are non-refundable except where required by law or expressly
          stated at checkout. If a required payment fails, we may retry the
          charge and suspend or terminate paid access. We may change pricing or
          plan features prospectively after providing notice required by law.
        </p>
      </section>

      <section id="responsible-use">
        <h2>7. Responsible gambling</h2>
        <p>
          Never wager more than you can afford to lose. Set limits, avoid
          chasing losses, and do not wager while impaired. If gambling is
          causing harm, stop using the Service and seek help. In the United
          States, call or text 1-800-GAMBLER for confidential support. We may
          restrict access or provide responsible-gambling notices when we
          believe doing so is appropriate.
        </p>
      </section>

      <section id="acceptable-use">
        <h2>8. Acceptable use</h2>
        <p>You may not:</p>
        <ul>
          <li>
            use the Service for unlawful, fraudulent, or abusive activity;
          </li>
          <li>
            scrape, harvest, copy, resell, sublicense, mirror, or commercially
            exploit the Service or its data except with our written permission;
          </li>
          <li>
            reverse engineer, probe, bypass, disable, or interfere with
            security, access controls, rate limits, or technical protections;
          </li>
          <li>
            use bots or automated systems to access the Service without written
            authorization;
          </li>
          <li>
            upload malware, infringe rights, impersonate others, or interfere
            with another user; or
          </li>
          <li>
            use Service outputs to train or benchmark a competing model,
            product, or dataset without our written permission.
          </li>
        </ul>
      </section>

      <section id="third-parties">
        <h2>9. Third-party services and data</h2>
        <p>
          The Service may display or link to odds, statistics, content, or
          services supplied by sportsbooks, leagues, data providers, Stripe, and
          other third parties. We do not control and are not responsible for
          third-party availability, accuracy, security, policies, settlement
          decisions, or conduct. Third-party names and marks belong to their
          respective owners. Your dealings with a third party are solely between
          you and that third party and may be governed by separate terms.
        </p>
      </section>

      <section id="ownership">
        <h2>10. Ownership and license</h2>
        <p>
          The Service—including its software, design, selection and arrangement
          of data, models, reports, text, graphics, branding, and other
          materials—is owned by Find The Edge or its licensors and is protected
          by intellectual-property laws. Subject to these Terms, we grant you a
          limited, personal, revocable, non-exclusive, non-transferable license
          to use the Service for your own lawful, non-commercial purposes. No
          other rights are granted. Feedback you voluntarily provide may be used
          by us without restriction or compensation.
        </p>
      </section>

      <section id="availability">
        <h2>11. Changes, availability, and termination</h2>
        <p>
          We may add, remove, modify, suspend, or discontinue any part of the
          Service. We do not promise uninterrupted availability or preservation
          of any particular feature, market, report, or user data. You may stop
          using the Service at any time. We may suspend or terminate your access
          if you violate these Terms, create risk or legal exposure, fail to
          pay, or misuse the Service. Provisions that by their nature should
          survive termination will survive.
        </p>
      </section>

      <section id="disclaimers">
        <h2>12. Disclaimers</h2>
        <p className="legal-caps">
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, THE SERVICE IS PROVIDED “AS
          IS” AND “AS AVAILABLE,” WITHOUT WARRANTIES OF ANY KIND, EXPRESS,
          IMPLIED, OR STATUTORY. FIND THE EDGE DISCLAIMS ALL WARRANTIES OF
          MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, TITLE,
          NON-INFRINGEMENT, ACCURACY, COMPLETENESS, AVAILABILITY, AND RESULTS.
          WE DO NOT WARRANT THAT THE SERVICE WILL BE ERROR-FREE, SECURE,
          CURRENT, OR UNINTERRUPTED, OR THAT ANY DEFECT WILL BE CORRECTED.
        </p>
      </section>

      <section id="liability">
        <h2>13. Limitation of liability</h2>
        <p className="legal-caps">
          TO THE MAXIMUM EXTENT PERMITTED BY LAW, FIND THE EDGE AND ITS OWNER,
          AFFILIATES, LICENSORS, PROVIDERS, AND REPRESENTATIVES WILL NOT BE
          LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
          EXEMPLARY, OR PUNITIVE DAMAGES; LOST PROFITS, REVENUE, DATA, GOODWILL,
          OR OPPORTUNITY; WAGERING LOSSES; OR DAMAGES ARISING FROM THIRD-PARTY
          SERVICES, EVEN IF ADVISED OF THE POSSIBILITY. OUR TOTAL AGGREGATE
          LIABILITY ARISING OUT OF OR RELATING TO THE SERVICE OR THESE TERMS
          WILL NOT EXCEED THE GREATER OF (A) THE AMOUNT YOU PAID TO FIND THE
          EDGE DURING THE 12 MONTHS BEFORE THE EVENT GIVING RISE TO LIABILITY OR
          (B) $100.
        </p>
        <p>
          Some jurisdictions do not allow certain exclusions or limitations, so
          portions of this section may not apply to you. Nothing in these Terms
          limits liability that cannot legally be limited.
        </p>
      </section>

      <section id="indemnity">
        <h2>14. Indemnification</h2>
        <p>
          To the extent permitted by law, you agree to defend, indemnify, and
          hold harmless Find The Edge and its owner, affiliates, licensors,
          providers, and representatives from claims, liabilities, damages,
          judgments, losses, and reasonable costs (including attorneys’ fees)
          arising from your unlawful or unauthorized use of the Service, your
          violation of these Terms, or your infringement of another person’s
          rights. We may control the defense of any covered matter, and you
          agree to cooperate.
        </p>
      </section>

      <section id="disputes">
        <h2>15. Dispute resolution and individual arbitration</h2>
        <p>
          Before filing a claim, you and Find The Edge agree to try to resolve
          it informally for 30 days. Send a written notice describing the
          dispute, requested relief, and your contact information through{" "}
          <LegalContact />. If unresolved, either party may elect binding
          individual arbitration administered by the American Arbitration
          Association under its applicable Consumer Arbitration Rules. The
          Federal Arbitration Act governs this agreement to arbitrate.
          Arbitration may occur by video, telephone, documents, or in a mutually
          agreed location. Either party may bring an eligible individual claim
          in small-claims court.
        </p>
        <p className="legal-caps">
          YOU AND FIND THE EDGE WAIVE THE RIGHT TO A JURY TRIAL AND AGREE THAT
          CLAIMS MAY BE BROUGHT ONLY IN AN INDIVIDUAL CAPACITY, NOT AS A
          PLAINTIFF OR CLASS MEMBER IN ANY CLASS, CONSOLIDATED, REPRESENTATIVE,
          OR PRIVATE ATTORNEY GENERAL ACTION. THE ARBITRATOR MAY AWARD RELIEF
          ONLY TO THE INDIVIDUAL PARTY SEEKING RELIEF.
        </p>
        <p>
          You may opt out of arbitration by sending an unambiguous written
          opt-out notice through <LegalContact /> within 30 days after first
          accepting these Terms. If the class-action waiver is found
          unenforceable for a particular claim, that claim must proceed in court
          and not arbitration. Nothing prevents either party from seeking
          temporary injunctive relief to protect intellectual property, account
          security, or unauthorized access.
        </p>
      </section>

      <section id="governing-law">
        <h2>16. Governing law</h2>
        <p>
          Except to the extent federal law applies or applicable law provides
          otherwise, these Terms are governed by the laws of the State of
          Florida, without regard to conflict-of-laws rules. Any dispute not
          subject to arbitration must be brought exclusively in a state or
          federal court of competent jurisdiction in Florida, and each party
          consents to personal jurisdiction there.
        </p>
      </section>

      <section id="general">
        <h2>17. General terms</h2>
        <p>
          These Terms and the Privacy Policy are the entire agreement concerning
          the Service. If a provision is unenforceable, it will be enforced to
          the maximum lawful extent and the remaining provisions remain in
          effect. Our failure to enforce a provision is not a waiver. You may
          not assign these Terms without our written consent; we may assign them
          in connection with a reorganization, financing, merger, sale, or
          transfer of the Service. Section headings are for convenience only.
        </p>
      </section>

      <section id="changes">
        <h2>18. Changes and contact</h2>
        <p>
          We may update these Terms. Material changes will be posted with a new
          effective date and, where required, additional notice. Continued use
          after updated Terms become effective constitutes acceptance. Questions
          or legal notices may be directed to <LegalContact />.
        </p>
      </section>
    </>
  );
}

function PrivacyPolicy() {
  return (
    <>
      <section id="scope">
        <h2>1. Scope and controller</h2>
        <p>
          This Privacy Policy explains how the owner and operator of Find The
          Edge (“Find The Edge,” “we,” “us,” or “our”) collects, uses,
          discloses, and protects personal information when you use our
          websites, applications, analytics, subscriptions, and related services
          (collectively, the “Service”). It does not govern independent third
          parties, including sportsbooks and websites you visit through links.
        </p>
      </section>

      <section id="collection">
        <h2>2. Information we collect</h2>
        <ul>
          <li>
            <strong>Account and identity data:</strong> phone number, account
            identifier, authentication status, one-time-passcode events, age or
            eligibility confirmations, and account preferences.
          </li>
          <li>
            <strong>Subscription and transaction data:</strong> plan, trial and
            renewal dates, payment status, billing country or postal code,
            Stripe customer references, and limited transaction metadata. Stripe
            processes payment-card details; we do not intend to store full card
            numbers or security codes.
          </li>
          <li>
            <strong>Usage and device data:</strong> IP address, browser and
            device type, operating system, pages and features used, timestamps,
            referring URLs, approximate location derived from IP, cookie or
            similar identifiers, and diagnostic, security, and performance logs.
          </li>
          <li>
            <strong>Product activity:</strong> watchlists, filters, settings,
            reports viewed, bets or results you choose to track, and
            interactions with recommendations and alerts.
          </li>
          <li>
            <strong>Communications:</strong> support requests, feedback, survey
            responses, and messages you send us.
          </li>
          <li>
            <strong>Derived data:</strong> inferred interests, feature
            preferences, subscription eligibility, fraud or abuse indicators,
            and aggregated or de-identified analytics.
          </li>
        </ul>
      </section>

      <section id="sources">
        <h2>3. Sources of information</h2>
        <p>
          We collect information directly from you, automatically from your
          browser or device, from service providers such as authentication,
          hosting, analytics, security, and payment providers, and from lawful
          public or commercial sources. We may combine information from these
          sources.
        </p>
      </section>

      <section id="uses">
        <h2>4. How we use information</h2>
        <ul>
          <li>provide, personalize, maintain, and improve the Service;</li>
          <li>authenticate users and secure accounts;</li>
          <li>process trials, subscriptions, payments, and cancellations;</li>
          <li>deliver reports, alerts, support, and service communications;</li>
          <li>
            analyze usage, measure performance, debug errors, and develop
            features and models;
          </li>
          <li>
            prevent fraud, abuse, scraping, unauthorized access, and other harm;
          </li>
          <li>comply with law and enforce our agreements; and</li>
          <li>
            create aggregated or de-identified information that does not
            reasonably identify you.
          </li>
        </ul>
      </section>

      <section id="disclosures">
        <h2>5. How we disclose information</h2>
        <p>We may disclose personal information to:</p>
        <ul>
          <li>
            vendors that provide cloud hosting, authentication, messaging,
            analytics, customer support, fraud prevention, security, and other
            operational services;
          </li>
          <li>
            Stripe and related payment providers to process and manage billing;
          </li>
          <li>
            professional advisers, auditors, insurers, and financing sources
            subject to appropriate obligations;
          </li>
          <li>
            government authorities or other parties when reasonably necessary to
            comply with law, legal process, protect rights and safety,
            investigate abuse, or enforce our agreements; and
          </li>
          <li>
            a buyer, investor, successor, or other participant in an actual or
            proposed merger, financing, reorganization, sale, bankruptcy, or
            transfer of all or part of the business.
          </li>
        </ul>
        <p>
          We may disclose information at your direction or with your consent. We
          may also disclose aggregated or de-identified information that cannot
          reasonably identify you.
        </p>
      </section>

      <section id="sale">
        <h2>6. Sale, sharing, and targeted advertising</h2>
        <p>
          We do not sell personal information for money. We do not knowingly
          sell or share personal information of anyone under 21. If we use
          advertising or analytics technologies in a way that applicable law
          defines as a “sale,” “sharing,” or targeted advertising, we will
          provide any required notice and opt-out mechanism and honor legally
          recognized opt-out preference signals, such as Global Privacy Control,
          where required.
        </p>
      </section>

      <section id="cookies">
        <h2>7. Cookies and similar technologies</h2>
        <p>
          We and our providers may use cookies, local storage, pixels, SDKs, and
          similar technologies to keep you signed in, remember settings, protect
          accounts, understand use, and improve performance. Browser controls
          may block or delete these technologies, but essential features may
          stop working. Because there is not yet a uniform industry standard, we
          do not respond to legacy “Do Not Track” signals unless required by
          law.
        </p>
      </section>

      <section id="retention">
        <h2>8. Data retention</h2>
        <p>
          We retain personal information only as long as reasonably necessary
          for the purposes described here, including to maintain your account,
          provide subscriptions, preserve security and audit records, resolve
          disputes, enforce agreements, and satisfy legal, tax, accounting, and
          regulatory obligations. Retention periods vary based on the type and
          sensitivity of data, the relationship with you, and applicable law.
          Aggregated or de-identified data may be retained longer.
        </p>
      </section>

      <section id="security">
        <h2>9. Security</h2>
        <p>
          We use reasonable administrative, technical, and organizational
          safeguards designed to protect personal information. No transmission,
          storage system, or security measure is guaranteed to be completely
          secure. You are responsible for protecting your phone, passcodes, and
          account sessions and for notifying us of suspected unauthorized use.
        </p>
      </section>

      <section id="choices">
        <h2>10. Your choices</h2>
        <p>
          You may update available account settings, manage browser storage,
          unsubscribe from optional marketing communications, and cancel a
          subscription through the controls provided with the Service. We may
          continue sending non-promotional account, billing, security, and legal
          notices. You may request account deletion, but we may retain
          information where permitted or required by law.
        </p>
      </section>

      <section id="state-rights">
        <h2>11. U.S. state privacy rights</h2>
        <p>
          Depending on your state and whether the applicable law covers our
          activities, you may have rights to request access, confirmation,
          correction, deletion, or portability of personal information; obtain a
          list of certain third parties; opt out of sale, sharing, targeted
          advertising, or qualifying profiling; limit certain uses of sensitive
          personal information; and appeal a denied request. You have the right
          not to receive unlawful discriminatory treatment for exercising a
          privacy right.
        </p>
        <p>
          Submit a request through <LegalContact /> and label it “Privacy
          Request.” Describe the right you wish to exercise and provide enough
          information to identify your account. We may verify your identity and
          authority before responding. An authorized agent may submit a request
          where permitted by law, but we may require proof of authorization and
          direct verification with you. We will respond within the period
          required by applicable law. If we deny an appealable request, you may
          appeal by replying through the same contact channel with “Privacy
          Appeal.”
        </p>
      </section>

      <section id="california">
        <h2>12. California disclosures</h2>
        <p>
          The categories described in Section 2 correspond to identifiers,
          customer-record information, commercial information, internet or other
          electronic-network activity, approximate geolocation, inferences, and
          account-login information. We collect, use, retain, and disclose these
          categories for the purposes described in Sections 4 and 5. In the
          preceding 12 months, we may have disclosed each category to the
          service providers and other recipients described in Section 5 for
          business purposes. We do not use or disclose sensitive personal
          information to infer characteristics about you beyond purposes
          permitted without a right to limit under California law.
        </p>
        <p>
          We do not offer financial incentives or price differences in exchange
          for personal information. California residents may exercise applicable
          rights using the process in Section 11. California’s “Shine the Light”
          law may also permit residents to request information about certain
          disclosures for direct-marketing purposes; we do not disclose personal
          information to third parties for their own direct marketing without
          consent.
        </p>
      </section>

      <section id="children">
        <h2>13. Age restriction and children</h2>
        <p>
          The Service is intended only for people 21 and older. We do not
          knowingly collect personal information from anyone under 13. If you
          believe a child has provided personal information, contact us so we
          can investigate and delete it as required by law.
        </p>
      </section>

      <section id="transfers">
        <h2>14. United States processing</h2>
        <p>
          Find The Edge is operated in the United States. If you access the
          Service from another country, your information may be transferred to,
          stored in, and processed in the United States and other countries
          where our providers operate, which may have different data-protection
          laws.
        </p>
      </section>

      <section id="updates">
        <h2>15. Updates and contact</h2>
        <p>
          We may update this Privacy Policy to reflect changes in the Service,
          our practices, or law. We will post the updated version with a revised
          effective date and provide additional notice where required. For
          privacy questions or requests, contact <LegalContact />.
        </p>
      </section>
    </>
  );
}

export function PublicLegalPage({
  kind,
}: {
  readonly kind: "terms" | "privacy";
}) {
  const terms = kind === "terms";
  return (
    <main className="public-legal">
      <div className="public-legal-shell">
        <header>
          <Link to="/" className="public-legal-back">
            ← FIND THE EDGE
          </Link>
          <p className="landing-kicker">PUBLIC LEGAL</p>
          <h1>{terms ? "Terms of Use" : "Privacy Policy"}</h1>
          <p className="public-legal-date">Effective {EFFECTIVE_DATE}</p>
          <p className="public-legal-summary">
            {terms
              ? "These Terms govern your use of Find The Edge, including accounts, subscriptions, analytics, and reports. Please read them carefully."
              : "This Policy explains what personal information Find The Edge collects, why we use it, how we disclose it, and the choices available to you."}
          </p>
        </header>

        <article className="public-legal-content">
          {terms ? <TermsOfUse /> : <PrivacyPolicy />}
        </article>

        <footer className="public-legal-footer">
          <Link to="/">Return to Find The Edge</Link>
          <span>Effective {EFFECTIVE_DATE}</span>
        </footer>
      </div>
    </main>
  );
}
