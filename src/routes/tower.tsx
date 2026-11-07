import { get } from '../lib/router';
import * as T from '../lib/tower';
import { render } from '../views/layout';
import { TowerPage } from '../views/tower';

get('/tower', 'perm:finance.view', async (c) => {
  const org = T.towerOrg(c.actor);
  const b = await T.book(org);
  c.html(render(<TowerPage c={c} s={T.summarise(b)} b={b} sites={await T.collateralSites(b)} w={await T.work(c.actor, org)} check={org ? await T.checklist(org) : { items: [], done: 0 }} kitovu={!org} />));
});
get('/tower/loan-book.csv', 'perm:finance.view', async (c) => {
  const csv = await T.loanBookCsv(c.actor);
  c.download(csv, 'text/csv; charset=utf-8', `storagex-loan-book-${new Date().toISOString().slice(0, 10)}.csv`);
});
