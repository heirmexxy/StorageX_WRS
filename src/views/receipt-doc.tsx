import { qrSvg } from '../lib/qr';
import { asset } from '../lib/assets';
import { facts, TERMS, COMPANY, whenText, valueLines, type ReceiptDoc } from '../lib/receipt-doc';

/** A warehouse receipt as a document, the same layout as the printed PDF. */
export function ReceiptDocument({ d, compact }: { d: ReceiptDoc; compact?: boolean }) {
  return (
    <article className={`wr${compact ? ' wr-compact' : ''}`} aria-label={`Warehouse receipt ${d.receipt_no}`}>
      <header className="wr-band">
        <img src={asset('/brand/storagex-logo-reversed.svg')} alt="StorageX by Kitovu" className="wr-logo" width="170" height="45" />
        <div className="wr-title"><b>Electronic warehouse receipt</b><span>Printed copy of the live record</span></div>
      </header>
      <div className="wr-body">
        <div className="wr-main">
          <span className="wr-k">Receipt number</span>
          <span className="wr-no">{d.receipt_no}</span>
          <span className={`wr-status s-${d.status}`}>{`Status: ${d.status_label}`}</span>
          <dl className="wr-facts">
            {facts(d).map(([k, v]) => <div key={k}><dt>{k}</dt><dd className={k === 'Net weight' ? 'b' : ''}>{v}</dd></div>)}
          </dl>
        </div>
        <a className="wr-qr" href={d.url} aria-label="Check the live record">
          <span dangerouslySetInnerHTML={{ __html: qrSvg(d.url, { size: 132 }) }} />
          <small>Scan to check the live record before you rely on this paper.</small>
        </a>
      </div>
      {(() => { const v = valueLines(d); const n = (x: string) => x.replace(/NGN /g, '₦'); return (
        <section className="wr-value"><div><span className="wr-k">Value at storage</span><b>{n(v.amount)}</b></div><p>{n(v.detail)}</p></section>
      ); })()}
      <section className="wr-terms">
        <h3>Terms of this receipt</h3>
        <ol>{TERMS.map((t, i) => <li key={i}>{t}</li>)}</ol>
      </section>
      <footer className="wr-sign">
        <div><small>For the warehouse operator</small><b>{d.warehouse}</b><span>{d.received_by ? `Received and weighed by ${d.received_by}` : 'Received and weighed at intake'}</span></div>
        <div><small>For Kitovu Technology Company Limited</small><b>{d.issued_by ? `Issued by ${d.issued_by}` : 'Issued by StorageX'}</b><span>{d.signature ? `Digitally signed${d.key_id ? ` · key ${d.key_id}` : ''}` : `Issued through StorageX on ${whenText(d.issued_at).replace(/,? at \d{2}:\d{2} WAT$/, '')}`}</span></div>
      </footer>
      <p className="wr-company">{COMPANY}</p>
    </article>
  );
}
