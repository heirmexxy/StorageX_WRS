import type { Ctx } from '../lib/http';

const SHOWN: [string, string, string][] = [
  ['warehouse_operator', 'Warehouse owners', 'Get your store certified, fill it with depositors, and earn storage fees on stock that lenders accept.'],
  ['field_partner_network', 'Field agent networks', 'Your agents register and support farmers, and connect them to storage, loans and buyers.'],
  ['cooperative', 'Co-operatives and associations', 'Store together, sell together in larger lots, and give members access to credit.'],
  ['buyer', 'Buyers and processors', 'Buy graded, weighed stock from certified warehouses in the lots you need.'],
  ['insurer', 'Insurers', 'Cover stored produce at sites with counts, photos and records behind every bag.'],
  ['input_supplier', 'Input suppliers and agro-dealers', 'Sell next season’s inputs to farmers who can pay from their stored produce.'],
  ['logistics', 'Transporters', 'Carry planned loads at known weights between farms, warehouses and buyers.'],
  ['inspection', 'Inspectors and collateral managers', 'Grade, inspect and monitor stock across certified warehouses.'],
  ['payments', 'Banks, fintechs and telcos', 'Handle buyer collections and farmer payouts, including mobile money.'],
  ['distribution_partner', 'Trading platforms', 'Offer eligible receipts to your users through the StorageX API.'],
  ['development', 'Development partners and guarantee funds', 'Back farmers with funding or guarantees, and see the results in the data.'],
  ['government', 'Government and agencies', 'Bring a working receipt system to your state’s farmers and public warehouses.'],
];
const CTA: Record<string, string> = { warehouse_operator: 'Partner as a warehouse owner', field_partner_network: 'Partner as a network', cooperative: 'Partner as a co-operative', buyer: 'Partner as a buyer', insurer: 'Partner as an insurer',
  input_supplier: 'Partner as a supplier', logistics: 'Partner as a transporter', inspection: 'Partner as an inspector', payments: 'Partner on payments', distribution_partner: 'Partner as a platform', development: 'Partner on a programme', government: 'Partner as an agency' };

/** Public landing page, written on the StoryBrand frame: the lender is the hero, Kitovu the guide. */
export function LandingPage({ c }: { c: Ctx }) {
  void c;
  return (
    <html lang="en">
      <head>
        <meta charSet="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>StorageX by Kitovu · Lend against grain you can check</title>
        <meta name="description" content="StorageX turns produce in certified Nigerian warehouses into receipts lenders can check at any time: the stock, its value, and whether anyone else has a claim on it." />
        <link rel="stylesheet" href="/landing.css" />
      </head>
      <body className="lp">
        <a className="skip" href="#main">Skip to content</a>
        <header className="lp-top">
          <a className="lp-brand" href="/">StorageX <span>by Kitovu</span></a>
          <nav aria-label="Main">
            <a href="#how">How it works</a>
            <a href="#partners">Other partners</a>
            <a href="/sample-receipt">Check a receipt</a>
            <a href="/login">Sign in</a>
            <a className="lp-btn" href="/apply">Apply to partner</a>
          </nav>
        </header>

        <main id="main">
          <section className="hero">
            <div className="hero-copy">
              <h1>Lend against grain you can check.</h1>
              <p className="lead">StorageX turns maize, soybean, sorghum and rice held in certified Nigerian warehouses into receipts. Each one shows, at any moment, whether the bags are still there, what they are worth today, and whether anyone else already has a claim on them.</p>
              <div className="ctas">
                <a className="lp-btn big" href="/apply">Apply to partner</a>
                <a className="lp-link" href="/sample-receipt">See a sample receipt</a>
              </div>
            </div>
            <figure className="stackcard" aria-label="Example of a StorageX warehouse receipt">
              <div className="sc-head">
                <span className="sc-no">SX-NI-MNA-261107-0001</span>
                <span className="stamp">Valid</span>
              </div>
              <dl>
                <div><dt>Produce</dt><dd>Maize, grade A</dd></div>
                <div><dt>Net weight</dt><dd>1,000 kg in 10 bags</dd></div>
                <div><dt>Warehouse</dt><dd>Minna, Niger State</dd></div>
                <div><dt>Value today</dt><dd>₦452,500</dd></div>
              </dl>
              <ol className="sc-hist">
                <li>Weighed in, scale photographed</li>
                <li>Checked by a second person</li>
                <li>Receipt issued and signed</li>
                <li>Pledged to one lender only</li>
              </ol>
              <figcaption>Illustration. Every real receipt has a public page like this, reached by its QR code.</figcaption>
            </figure>
          </section>

          <section className="problem">
            <h2>Rural lending fails on three questions nobody can answer.</h2>
            <div className="three">
              <div><h3>Is the stock really there?</h3><p>A paper receipt says nothing about what happened in the warehouse last week. Bags leave, get re-weighed, get damaged.</p></div>
              <div><h3>Has someone else lent against it?</h3><p>The same bags can back two loans at two banks, and neither bank finds out until both try to collect.</p></div>
              <div><h3>What is it worth today?</h3><p>Grain prices swing with every harvest. A loan that was safe in October can be under water by January without anyone noticing.</p></div>
            </div>
            <p className="why">Meanwhile farmers sell at harvest, when prices are lowest, because nobody will lend against the grain they already own. That is the part we set out to change.</p>
          </section>

          <section className="guide">
            <div className="guide-copy">
              <h2>We built the warehouse record lenders asked for.</h2>
              <p>Kitovu has worked on farm storage and finance in Nigeria since 2016. When we sat with lenders, they did not ask for an app. They asked for a record they could trust as much as their own ledger. StorageX is that record.</p>
            </div>
            <ul className="controls">
              <li><b>Weights you can see.</b> Every weighing comes with a photo of the scale display, and an AI check compares the photo with the number typed in.</li>
              <li><b>Two people for every decision that matters.</b> Deliveries, receipts, releases, price entries and loan payouts each need a second person. The database refuses the same person twice.</li>
              <li><b>One pledge per receipt.</b> A receipt pledged to you cannot be pledged to anyone else, withdrawn or sold until your loan is repaid.</li>
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
            <h2>Not a lender? There is a part for you.</h2>
            <p className="partners-lead">A receipt system works only when many hands do their part well. These are the partners StorageX is built with.</p>
            <ul className="plist">
              {SHOWN.map(([k, t, line]) => (
                <li key={k}>
                  <h3>{t}</h3>
                  <p>{line}</p>
                  <a href={`/apply?type=${k}`}>{CTA[k] ?? 'Partner with us'}</a>
                </li>
              ))}
              <li className="farmers">
                <h3>Farmers</h3>
                <p>You do not need to sign up here. Ask a Kitovu field partner in your community, or call Kitovu, and they will register you.</p>
              </li>
            </ul>
          </section>

          <section className="final">
            <h2>Start with one warehouse and one crop.</h2>
            <p>Tell us who you are. Our team reviews every application and calls you, usually within five working days.</p>
            <a className="lp-btn big" href="/apply">Apply to partner</a>
          </section>
        </main>

        <footer className="lp-foot">
          <p>StorageX is built and operated by Kitovu Technology Company Limited, Oyo State, Nigeria.</p>
          <p><a href="#partners">Partners</a> <a href="/sample-receipt">Check a receipt</a> <a href="/apply">Apply to partner</a> <a href="/login">Staff and partner sign in</a></p>
        </footer>
      </body>
    </html>
  );
}
