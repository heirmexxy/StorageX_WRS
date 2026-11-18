import type { Ctx } from '../lib/http';
import { Page } from './layout';

/** How to check a receipt. Real receipts are reached only through their QR code or the link texted to the farmer. */
export function CheckReceiptPage({ c, list }: { c: Ctx; list: string[] }) {
  return (
    <Page c={c} title="Check a receipt" bare wide>
      <section className="card">
        <h1>Check a warehouse receipt</h1>
        <p>Every StorageX receipt has a live record. Scan the QR code on the printed receipt, or open the link texted to the depositor, and you see what is true right now: whether the produce is still in the warehouse, how much of it, and whether it is pledged to a lender or being sold.</p>
        <ol>
          <li>Scan the QR code with your phone camera. No app or sign-in is needed.</li>
          <li>Check that the receipt number, commodity, weight and warehouse match the paper.</li>
          <li>Read the status. Lend, buy or release only against a record that says <b>Valid</b>, and check it on the day you rely on it.</li>
        </ol>
        <p>A QR code that opens nowhere, or a record that does not match the paper, means the paper is not a valid receipt. Call Kitovu.</p>
        <h2>What a receipt looks like</h2>
        <ul>{list.map((no) => <li key={no}><a className="mono" href={`/check-receipt/${no}`}>{no}</a></li>)}</ul>
      </section>
    </Page>
  );
}
