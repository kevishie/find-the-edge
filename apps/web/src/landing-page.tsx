import { landingConfig } from "./landing-config";

const rows = [
  ["Netherlands v Germany", "FIFA WC26 · 4:00 PM ET", "Neth or Draw", "-120", "-115", "-138", "+6.3%", "57%", "5"],
  ["England v Portugal", "FIFA WC26 · 12:00 PM ET", "BTTS — Yes", "+100", "+102", "-113", "+6.0%", "79%", "6"],
  ["France v Spain", "FIFA WC26 · 3:00 PM ET", "1st Half Draw", "+115", "+120", "+106", "+4.3%", "84%", "6"],
  ["France v Spain", "FIFA WC26 · 3:00 PM ET", "Under 2.5 Goals", "-110", "-104", "-120", "+4.0%", "61%", "6"],
] as const;
const books = ["HARD ROCK FL", "DRAFTKINGS", "FANDUEL", "BETMGM", "CAESARS", "CIRCA", "FANATICS"];
const features = [
  ["✦", "+EV SCANNER", "Every qualified edge on the board, ranked by expected value. Filter by sport, market, book, minimum EV, confidence, book count and odds freshness."],
  ["⊞", "ODDS TERMINAL", "Six books side by side with best price and Hard Rock highlighted, plus market average, no-vig fair odds, opening vs current, and suspended-market flags."],
  ["▤", "SCOUTING REPORTS", "Fourteen-section deep dives on any fixture — tactical matchup, player matchups, advanced metrics, market edge, risk, final plays. Every claim carries a source and a timestamp."],
  ["▦", "BETTING SPLITS", "DraftKings and Circa consensus on tickets versus money. Where handle diverges from bet count, you see it as color and distance, not a paragraph."],
  ["◔", "LINE MOVEMENT", "Full price history per market with open-to-current deltas, steam detection, and stale-data warnings when a feed falls behind."],
  ["◈", "BET TRACKER", "Log a bet in two clicks straight from the recommendation that produced it. Open, won, lost, pushed, cashed out and void all settle with closing line value attached."],
  ["◹", "PERFORMANCE", "ROI and profit, but weighted toward process: closing line value, calibration curves, Brier score, and results split by sport, market, confidence tier and model version."],
  ["⬢", "DATA PROVENANCE", "Every provider's status, last sync, quota and error surfaced on one screen. When something is stale or inferred rather than verified, the number says so."],
  ["⊙", "EVENTS & WATCHLIST", "Filter the full slate by sport, league, date, report status and lineup status. Star the fixtures you are tracking and they surface on the dashboard as kickoff approaches."],
] as const;
const steps = [
  ["STEP 01", "Open the board", "The dashboard answers one question on load: where is the edge right now. Ranked opportunities, market discrepancies, and anything on your watchlist starting soon."],
  ["STEP 02", "Check the evidence", "Open the scouting report. Fair probability against Hard Rock implied, the size of the gap, how many books corroborate it, and whether line movement agrees."],
  ["STEP 03", "Place it and track it", "Log the bet with a suggested fractional-Kelly stake. It stays linked to the recommendation, so performance can tell you which model version is actually earning."],
] as const;
const included = ["Unlimited scouting reports", "All markets and leagues", "Six-book odds comparison", "DK / Circa betting splits", "Unlimited bet tracking", "Closing line value analytics", "Custom EV and confidence thresholds", "Soccer now — NFL, NBA and esports next"];
const faqs = [
  ["Is this a picks service?", "No. Find The Edge prices markets and shows you the math behind the price. You decide what to bet — every recommendation shows its fair probability, book count and confidence so you can disagree with it."],
  ["Which sportsbook does it target?", "Hard Rock Bet Florida is the default target book, compared against DraftKings, FanDuel, BetMGM, Caesars, Circa and Fanatics. You can weight books or change the target in settings."],
  ["What happens after the trial?", "Day seven ends and you are billed $99 monthly or $999 annually, whichever you chose. Cancel before then and you are not charged at all."],
  ["Which sports are covered?", "Soccer is live today with full market coverage. NFL, NBA and esports are next — the engine and design system already support them."],
  ["How current is the data?", "Odds refresh continuously and every price carries an age. Anything past your freshness threshold is badged stale and excluded from qualified opportunities."],
] as const;

function Crown({ large = false }: { readonly large?: boolean }) { return <svg className={large ? "ref-crown large" : "ref-crown"} viewBox="0 0 30 24" fill="none" aria-hidden="true"><path d="M2 20 L5 7 L11 14 L15 4 L19 14 L25 7 L28 20 Z" fill="#8b5cf6" stroke="#c084fc" strokeWidth="1" strokeLinejoin="round"/><rect x="3" y="20" width="24" height="3" rx="1" fill="#c084fc"/></svg>; }
const StartLink = ({ children }: { readonly children: string }) => landingConfig.authPath ? <a className="ref-primary" href={landingConfig.authPath}>{children}</a> : <a className="ref-primary" href="#pricing">{children}</a>;

export function LandingPage() {
  return <div className="ref-page">
    <header className="ref-header"><div className="ref-nav"><a className="ref-brand" href="#top"><Crown/><b>FIND THE <i>EDGE</i></b></a><nav><a href="#features">Features</a><a href="#how">How it works</a><a href="#pricing">Pricing</a></nav><StartLink>Start free trial</StartLink></div></header>
    <main>
      <section className="ref-hero" id="top"><div className="ref-florida" aria-hidden="true"><svg viewBox="0 0 100 120"><path d="M6 26 L58 24 L62 34 L72 34 L78 42 L84 54 L80 68 L72 84 L64 98 L56 112 L52 108 L54 92 L50 78 L42 68 L32 60 L20 54 L10 44 Z"/></svg></div><div className="ref-wrap">
        <div className="ref-live"><span/> LIVE ODDS · 6 BOOKS · FLORIDA MARKET</div>
        <h1>Stop shopping lines.<br/>Start pricing them.</h1>
        <p className="ref-lede">A private betting terminal that builds a no-vig fair line from six books, flags where Hard Rock is off it, and shows you the evidence behind every number.</p>
        <div className="ref-actions"><StartLink>Start 7-day free trial</StartLink><a className="ref-secondary" href="#features">See what's inside</a></div>
        <p className="ref-price-note">$99/mo or $999/yr · cancel anytime · no card charged for 7 days</p>
        <div className="ref-scanner"><div className="ref-scanner-top"><span>+EV SCANNER</span><em>● FRESH · 2m</em><small>4 qualified · sorted by EV</small></div><div className="ref-table"><div className="ref-row ref-head"><span>EVENT</span><span>SELECTION</span><span>HARD ROCK</span><span>BEST</span><span>FAIR</span><span>EV</span><span>CONF</span></div>{rows.map((r)=><div className="ref-row" key={r[0]+r[2]}><span><b>{r[0]}</b><small>{r[1]}</small></span><span>{r[2]}</span><span>{r[3]}</span><span>{r[4]}</span><span>{r[5]}</span><strong>{r[6]}</strong><span className="ref-conf"><i><b style={{width:r[7]}}/></i>{r[8]}</span></div>)}</div></div>
      </div></section>
      <section className="ref-books"><div className="ref-wrap"><small>PRICES FROM</small>{books.map(b=><span key={b}>{b}</span>)}</div></section>
      <section className="ref-section" id="features"><div className="ref-wrap"><h2>Everything you need to price a bet</h2><p>Nine tools that share one engine, so the number on the scanner is the same number in the report and the same number in your bet log.</p><div className="ref-features">{features.map(([icon,title,body])=><article key={title}><div><span>{icon}</span><h3>{title}</h3></div><p>{body}</p></article>)}</div></div></section>
      <section className="ref-section alt" id="how"><div className="ref-wrap"><h2>Dashboard to placed bet in three moves</h2><div className="ref-steps">{steps.map(([n,t,b])=><article key={n}><small>{n}</small><h3>{t}</h3><p>{b}</p></article>)}</div></div></section>
      <section className="ref-section" id="pricing"><div className="ref-wrap"><div className="ref-center"><h2>One plan. Every tool.</h2><p>Seven days free. No card charged until day eight.</p></div><div className="ref-plans"><article><small>MONTHLY</small><div><b>$99</b><span>/ month</span></div><p>Billed monthly. Cancel anytime.</p><a className="ref-plan-secondary" href={landingConfig.authPath || "#pricing"}>Start free trial</a></article><article className="featured"><em>SAVE $189</em><small>ANNUAL</small><div><b>$999</b><span>/ year</span></div><p>Works out to $83/mo — $189 off the monthly rate.</p><StartLink>Start free trial</StartLink></article></div><div className="ref-included"><small>BOTH PLANS INCLUDE</small><div>{included.map(i=><span key={i}><i>✓</i>{i}</span>)}</div></div></div></section>
      <section className="ref-faq"><div><h2>Questions</h2>{faqs.map(([q,a])=><article key={q}><h3>{q}</h3><p>{a}</p></article>)}</div></section>
      <section className="ref-final"><Crown large/><h2>Find the edge tonight</h2><p>Seven days of the full terminal. If the numbers don’t hold up, walk away before you’re billed.</p><StartLink>Start 7-day free trial</StartLink></section>
    </main>
    <footer className="ref-footer"><div><b>FIND THE <i>EDGE</i></b><span>© 2026</span><nav><a href="/terms">Terms</a><a href="/privacy">Privacy</a><a href="mailto:support@findtheedge.com">Contact</a></nav><p>Must be 21+. Analytics and research only — Find The Edge does not accept wagers and is not affiliated with any sportsbook. Expected value is a long-run estimate, not a forecast of any single result. Gambling problem? Call 1-800-GAMBLER.</p></div></footer>
  </div>;
}
