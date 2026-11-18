import type { Ctx } from '../lib/http';
import { PARTNER_TYPES, PARTNER_GROUPS } from '../lib/applications';
import { showcaseDoc } from '../lib/showcase';
import { config } from '../lib/config';
import { Icons } from './layout';
import { ReceiptDocument } from './receipt-doc';

/** Public landing page, written on the StoryBrand frame: the lender is the hero, Kitovu the guide. */
export function LandingPage({ c }: { c: Ctx }) {
  void c;
  const receipt = showcaseDoc('SX-OY-ISY-261104-0018')!;
  const site = config.baseUrl.replace(/\/$/, '');
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>StorageX by Kitovu · Lend against a commodity you can track</title>
        <meta name="description" content="StorageX turns commodities held in certified Nigerian warehouses into receipts lenders can track at any time: the stock, its value, and whether anyone else has a claim on it." />
        <meta property="og:title" content="StorageX by Kitovu · Lend against a commodity you can track" />
        <meta property="og:description" content="Warehouse receipts for commodities in certified Nigerian warehouses, tracked from intake to sale." />
        <meta property="og:image" content={`${site}/og.png`} />
        <meta property="og:url" content={site} />
        <meta name="twitter:card" content="summary_large_image" />
        <link rel="stylesheet" href="/landing.css" />
        <link rel="stylesheet" href="/receipt.css" />
        <Icons />
      </head>
      <body className="lp">
        <a className="skip" href="#main">Skip to content</a>
        <header className="lp-top">
          <a className="lp-brand" href="/"><img src="/brand/storagex-logo.svg" alt="StorageX by Kitovu" width="190" height="51" /></a>
          <nav aria-label="Main">
            <a href="#watch">How it works</a>
            <a href="#partners">Partners</a>
            <a href="/check-receipt">Check a receipt</a>
            <a href="/login">Sign in</a>
            <a className="lp-btn" href="/apply">Apply to partner</a>
          </nav>
        </header>

        <main id="main">
          <section className="hero">
            <div className="hero-copy">
              <h1>Lend against a commodity you can track.</h1>
              <p className="lead">StorageX turns commodities like maize, soybean, sorghum and paddy rice, held in certified Nigerian warehouses, into receipts. Each one shows, at any moment, whether the stock is still there, what it is worth today, and whether anyone else already has a claim on it.</p>
              <div className="ctas">
                <a className="lp-btn big" href="/apply">Apply to partner</a>
                <a className="lp-link" href="#watch">Watch how it works</a>
              </div>
            </div>
            <div className="hero-receipt">
              <ReceiptDocument d={receipt} compact />
            </div>
          </section>

          <section className="watch" id="watch">
            <div className="watch-copy">
              <h2>From the farm gate to payment.</h2>
              <p>A farmer brings in a harvest. It is weighed, tested and graded, valued, and turned into a receipt. It is stored in a WareGuard-monitored warehouse, lent against, sold when the price is right, and the lender and the farmer are paid. Under two minutes, start to finish.</p>
            </div>
            <video className="watch-video" controls preload="none" playsInline poster="/media/storagex-how-it-works.jpg" width="1280" height="720">
              <source src="/media/storagex-how-it-works.mp4" type="video/mp4" />
              <a href="/media/storagex-how-it-works.mp4">Download the walkthrough video</a>
            </video>
          </section>

          <section className="problem">
            <h2>Rural lending fails on three questions nobody can answer.</h2>
            <div className="three">
              <div><h3>Is the stock really there?</h3><p>A paper receipt says nothing about what happened in the warehouse last week. Bags leave, get re-weighed, get damaged.</p></div>
              <div><h3>Has someone else lent against it?</h3><p>The same bags can back two loans at two banks, and neither bank finds out until both try to collect.</p></div>
              <div><h3>What is it worth today?</h3><p>Commodity prices swing with every harvest. A loan that was safe in October can be under water by January without anyone noticing.</p></div>
            </div>
            <p className="why">Meanwhile farmers sell at harvest, when prices are lowest, because nobody will lend against the harvest they already own. That is the part we set out to change.</p>
          </section>

          <section className="guide">
            <div className="guide-copy">
              <h2>We built the warehouse record lenders asked for.</h2>
              <p>Kitovu has worked on farm storage and finance in Nigeria since 2016. When we sat with lenders, they did not ask for an app. They asked for a record they could trust as much as their own ledger. StorageX is that record.</p>
            </div>
            <ul className="controls">
              <li><b>Weights you can see.</b> Every weighing comes with a photo of the scale display, and an AI check compares the photo with the number typed in.</li>
              <li><b>Two people for every decision that matters.</b> Deliveries, receipts, releases, price entries and loan payouts each need a second person. The database refuses the same person twice.</li>
              <li><b>Pledged to you, and you are paid first.</b> A pledged receipt cannot back anyone else’s loan. The stock leaves the warehouse only through a sale you approve, or after your loan is repaid, and the sale pays you before the farmer.</li>
              <li><b>Conditions watched around the clock.</b> In warehouses fitted with WareGuard, sensors track the moisture, temperature and humidity around the stock day and night.</li>
              <li><b>A dated, explainable value.</b> Each receipt is valued every morning from approved market prices, under your own haircut and loan-to-value rules.</li>
              <li><b>History that cannot be rewritten.</b> Every change to a receipt is sealed to the one before it, and its signature can be checked offline.</li>
              <li><b>Stock counted against receipts.</b> Physical counts are reconciled with the receipts. If the two disagree, the receipts are marked “under review” for everyone to see.</li>
            </ul>
          </section>

          <section className="plan" id="how">
            <h2>How it works for a lender</h2>
            <ol className="steps">
              <li><h3>Agree your rules</h3><p>Apply, and we set up your organisation. You choose the crops you lend against, your haircut, loan-to-value and loan products.</p></li>
              <li><h3>We bring verified farmers and certified stock</h3><p>Our field partners register farmers and check their identity. Warehouses are certified and insured. Deliveries are weighed, graded and turned into receipts.</p></li>
              <li><h3>Approve, pay out, and watch every day</h3><p>Loan requests arrive with the checks already done. You approve, record the payout, and see each loan against the live value of the stock behind it.</p></li>
            </ol>
            <a className="lp-btn" href="/apply">Apply to partner</a>
          </section>

          <section className="stakes">
            <div className="col without">
              <h2>Without a trusted record</h2>
              <ul><li>Farmers sell at the bottom of the market to pay school fees and the next season’s inputs.</li><li>Lenders keep rural agriculture loans small, or avoid them.</li><li>Stored grain sits idle as collateral nobody can use.</li></ul>
            </div>
            <div className="col with">
              <h2>With StorageX</h2>
              <ul><li>Farmers hold their grain for a better price and borrow against it meanwhile.</li><li>Lenders grow a rural book backed by stock they can see.</li><li>Warehouses fill up, and every bag in them earns its keep.</li></ul>
            </div>
          </section>

          <section className="partners" id="partners">
            <h2>Every partner has a part.</h2>
            <p className="partners-lead">A receipt system works only when many hands do their part well. Open your group to see what you bring, what you get, and how to start.</p>
            <div className="pgroups">
              {PARTNER_GROUPS.map((g) => (
                <details key={g.key} className="pgroup">
                  <summary><span className="pg-name">{g.label}</span><span className="pg-line">{g.line}</span></summary>
                  <ul className="plist">
                    {Object.entries(PARTNER_TYPES).filter(([, t]) => t.group === g.key).map(([k, t]) => (
                      <li key={k}>
                        <h3>{t.label}</h3>
                        <p>{t.pitch}</p>
                        <a href={`/apply?type=${k}`}>{t.cta}</a>
                      </li>
                    ))}
                  </ul>
                </details>
              ))}
            </div>
            <div className="farmers">
              <h3>Farmers</h3>
              <p>You do not need to sign up here. Ask a Kitovu field partner in your community, or call Kitovu, and they will register you.</p>
            </div>
          </section>

          <section className="final">
            <h2>Start with one warehouse and one commodity.</h2>
            <p>Tell us who you are. Our team reviews every application and calls you, usually within five working days.</p>
            <a className="lp-btn big" href="/apply">Apply to partner</a>
          </section>
        </main>

        <footer className="lp-foot">
          <p>StorageX is built and operated by Kitovu Technology Company Limited, Oyo State, Nigeria.</p>
          <p><a href="#partners">Partners</a> <a href="/check-receipt">Check a receipt</a> <a href="/apply">Apply to partner</a> <a href="/login">Staff and partner sign in</a></p>
        </footer>
      </body>
    </html>
  );
}
