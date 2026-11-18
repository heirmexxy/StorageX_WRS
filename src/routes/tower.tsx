import { get } from '../lib/router';
import * as T from '../lib/tower';
import { render } from '../views/layout';
import { TowerPage } from '../views/tower';
import { bookSeries } from '../lib/history';
import { unseenCount } from '../lib/alerts';
import { health } from '../lib/wareguard';

get('/tower', 'perm:finance.view', async (c) => {
  const org = T.towerOrg(c.actor);
  const b = await T.book(org);
  const sites = await T.collateralSites(b);
  const wg = await health(sites.map((x: any) => x.id), 24);
  for (const x of sites as any[]) x.wg = wg.find((h) => h.warehouse_id === x.id);
  c.html(render(<TowerPage c={c} s={T.summarise(b)} b={b} sites={sites} w={await T.work(c.actor, org)} check={org ? await T.checklist(org) : { items: [], done: 0 }} kitovu={!org}
    hist={await bookSeries(org)} alerts={await unseenCount(c.actor)} />));
});
get('/tower/loan-book.csv', 'perm:finance.view', async (c) => {
  const csv = await T.loanBookCsv(c.actor);
  c.download(csv, 'text/csv; charset=utf-8', `storagex-loan-book-${new Date().toISOString().slice(0, 10)}.csv`);
});
