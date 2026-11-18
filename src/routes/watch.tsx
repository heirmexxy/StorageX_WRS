import { get, post } from '../lib/router';
import { HttpError } from '../lib/http';
import * as AL from '../lib/alerts';
import * as W from '../lib/watch';
import { CONNECTED } from '../lib/wareguard';
import { render } from '../views/layout';
import { AlertsPage, WatchListPage, WatchSitePage } from '../views/watch';
import { act } from './admin';

get('/alerts', 'auth', async (c) => c.html(render(<AlertsPage c={c} rows={await AL.alertsFor(c.actor, { all: c.query.all })} all={c.query.all === '1'} />)));
post('/alerts/seen', 'auth', (c) => act(c, '/alerts', async () => { const n = await AL.markSeen(c.actor, c.body.id === 'all' ? 'all' : String(c.body.id)); return n ? 'Marked as seen.' : 'Already seen.'; }));
get('/stock-watch', 'perm:warehouses.view', async (c) => c.html(render(<WatchListPage c={c} rows={await W.sites(c.actor)} connected={await CONNECTED()} />)));
get('/stock-watch/:code', 'perm:warehouses.view', async (c) => {
  const s = await W.site(c.actor, c.params.code);
  if (!s) throw new HttpError(404, 'No such warehouse, or none of your stock is held there.');
  c.html(render(<WatchSitePage c={c} s={s} />));
});
