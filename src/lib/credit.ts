// Farmer credit history: what the farmer has done with StorageX loans, worked out from the loan records, never
// typed in. Each loan repaid on time builds the record; a lender may choose to lend a little more next season to
// a farmer with a strong one. StorageX only suggests the step-up; the lender's own policy decides.
import { db } from './db';
import { position, entriesOf } from './finance';

export type Tier = 'new' | 'building' | 'good' | 'strong' | 'problem';
export const TIER_LABEL: Record<Tier, string> = { new: 'No record yet', building: 'Building a record', good: 'Good record', strong: 'Strong record', problem: 'Problem on record' };
/** Points of loan-to-value a lender might add for each tier (suggestion only). */
export const UPLIFT_BP: Record<Tier, number> = { new: 0, building: 250, good: 500, strong: 750, problem: 0 };
const GRACE_DAYS = 3;

export async function creditHistory(farmerId: string, excludeLineId?: string) {
  const loans = await db.all<any>(`SELECT ln.*, o.name AS lender FROM loans ln JOIN organisations o ON o.id=ln.lender_org_id
    WHERE ln.farmer_id=$1 AND ln.status IN ('disbursed','repaid','written_off') AND ($2::uuid IS NULL OR ln.line_id <> $2) ORDER BY ln.disbursed_on NULLS LAST`, farmerId, excludeLineId ?? null);
  let onTime = 0, late = 0, maxLate = 0, borrowed = 0, repaidAmount = 0, overdueNow = 0, written = 0, open = 0;
  const rows = [];
  for (const ln of loans) {
    borrowed += Number(ln.principal_kobo);
    const entries = await entriesOf(ln.id);
    let lateDays = 0, result: string;
    if (ln.status === 'repaid') {
      const paidOn = ln.closed_at ? new Date(ln.closed_at) : new Date();
      lateDays = Math.max(0, Math.floor((paidOn.getTime() - new Date(ln.due_on).getTime()) / 86_400_000));
      if (lateDays <= GRACE_DAYS) { onTime++; result = 'Repaid on time'; } else { late++; maxLate = Math.max(maxLate, lateDays); result = `Repaid ${lateDays} days late`; }
      repaidAmount += entries.filter((e: any) => e.kind === 'repayment').reduce((n: number, e: any) => n + Number(e.amount_kobo), 0);
    } else if (ln.status === 'written_off') { written++; result = 'Written off'; }
    else {
      open++;
      const p = position(ln, entries);
      if (p.overdueDays > 0) { overdueNow = Math.max(overdueNow, p.overdueDays); result = `Running, ${p.overdueDays} days overdue`; } else result = 'Running';
    }
    rows.push({ loan_no: ln.loan_no, lender: ln.lender, principal: Number(ln.principal_kobo), disbursed_on: ln.disbursed_on, due_on: ln.due_on, result });
  }
  const tier: Tier = written || overdueNow > 30 || maxLate > 60 ? 'problem' : onTime === 0 ? 'new' : onTime >= 4 && late === 0 ? 'strong' : onTime >= 2 && maxLate <= 30 ? 'good' : 'building';
  const sales = Number(await db.val(`SELECT count(DISTINCT x.sale_id) FROM sale_items x JOIN sales s ON s.id=x.sale_id WHERE x.farmer_id=$1 AND s.status='settled'`, farmerId));
  const summary = tier === 'new' ? 'No StorageX loan repaid yet.'
    : `${onTime} loan${onTime === 1 ? '' : 's'} repaid on time${late ? `, ${late} late (at most ${maxLate} days)` : ''}${written ? `, ${written} written off` : ''}${open ? `, ${open} running${overdueNow ? ` (${overdueNow} days overdue)` : ''}` : ''}; ${sales} sale${sales === 1 ? '' : 's'} completed through StorageX.`;
  return { tier, label: TIER_LABEL[tier], uplift_bp: UPLIFT_BP[tier], onTime, late, maxLate, written, open, overdueNow, borrowed, repaidAmount, sales, summary, loans: rows };
}
