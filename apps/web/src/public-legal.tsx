import { Link } from "@tanstack/react-router";

export function PublicLegalPage({
  kind,
}: {
  readonly kind: "terms" | "privacy";
}) {
  const terms = kind === "terms";
  return (
    <main className="public-legal">
      <Link to="/" className="public-legal-back">
        ← FIND THE EDGE
      </Link>
      <p className="landing-kicker">PUBLIC LEGAL</p>
      <h1>{terms ? "Terms of Use" : "Privacy Notice"}</h1>
      <p className="public-legal-status" role="status">
        DRAFT — NOT APPROVED FOR LAUNCH
      </p>
      <p>
        {terms
          ? "Final subscription, cancellation, refund, eligibility, and responsible-gaming terms are under review. No commercial promise is created by this draft page."
          : "Final disclosures for phone identifiers, authentication, billing metadata, analytics, retention, and user rights are under review."}
      </p>
      <p>
        Must be 21+. FIND THE EDGE provides analytics and research and does not
        accept or place wagers.
      </p>
    </main>
  );
}
