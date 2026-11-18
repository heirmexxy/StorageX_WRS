import { get } from '../lib/router';
import { sortOffers } from '../lib/agents/offer-sorter';
import { render } from '../views/layout';
import { OffersPage } from '../views/offers';

get('/offers', 'perm:finance.view', async (c) => c.html(render(<OffersPage c={c} lots={await sortOffers(c.actor)} />)));
