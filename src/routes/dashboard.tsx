import { get } from '../lib/router';
import { HttpError } from '../lib/http';
import type { Ctx } from '../lib/http';

const kitovuOnly = (c: Ctx) => { if (c.membership?.org_kind !== 'kitovu') throw new HttpError(403, 'The business dashboard is for Kitovu management.'); };
import * as D from '../lib/dashboard';
import { bookSeries } from '../lib/history';
import { CONNECTED } from '../lib/wareguard';
import { render } from '../views/layout';
import { DashboardPage } from '../views/dashboard';

get('/dashboard', 'perm:reports.view', async (c) => {
  kitovuOnly(c); D.mayView(c.actor);
  c.html(render(<DashboardPage c={c} rev={await D.revenue()} growth={await D.farmerGrowth()} flows={await D.flows()} snap={await D.snapshot()} book={await bookSeries(null)} connected={await CONNECTED()} />));
});
get('/dashboard/revenue.csv', 'perm:reports.view', async (c) => { kitovuOnly(c); c.download(await D.revenueCsv(c.actor), 'text/csv; charset=utf-8', `storagex-revenue-${new Date().toISOString().slice(0, 10)}.csv`); });
