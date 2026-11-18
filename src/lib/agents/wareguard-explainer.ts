// WareGuard alert explainer. When a warehouse reading goes outside safe limits, it says in plain words what is
// happening, why it matters for the stock stored there, and what the warehouse team should do, in order.
// The advice is a fixed playbook in code, chosen by the kind of alert, how far past the limit it is, how long it
// has lasted and which crops are in the store. If the AI is switched on it may rewrite the summary for the
// reader; it never adds steps, changes the urgency or decides anything.
import { getSettings } from '../settings';
import { config } from '../config';
import { defaultModel, type ModelCall } from './model';

export type SensorKind = 'high_temperature' | 'high_humidity' | 'door_open' | 'offline';
export interface Situation {
  kind: SensorKind; warehouse: string; device: string | null;
  value: number | null; limit: number; minutes: number;
  crops: { name: string; kg: number; moisture: number | null }[];
  pledged_kg: number; release_ordered: boolean;
}
export interface Advice { headline: string; why: string; actions: string[]; urgency: 'warn' | 'urgent'; for_lenders: string; note?: string | null }

const MOULD_PRONE = /maize|groundnut|sorghum|millet|rice|paddy/i;
const kg = (n: number) => `${Math.round(n).toLocaleString('en-NG')} kg`;
const dur = (m: number) => (m < 90 ? `${Math.round(m)} minutes` : m < 48 * 60 ? `${Math.round(m / 60)} hours` : `${Math.round(m / 1440)} days`);

/** The playbook. Same inputs, same advice, every time. */
export function playbook(s: Situation): Advice {
  const crops = s.crops.map((c) => c.name).join(', ') || 'the stored produce';
  const total = s.crops.reduce((n, c) => n + c.kg, 0);
  const lend = s.pledged_kg > 0 ? `${kg(s.pledged_kg)} here is pledged to lenders. ` : '';
  const damp = s.crops.filter((c) => c.moisture != null && c.moisture >= 13).map((c) => c.name);
  switch (s.kind) {
    case 'high_humidity': {
      const over = (s.value ?? s.limit) - s.limit, long = s.minutes >= 6 * 60;
      const urgent = over >= 10 || (long && over >= 5);
      return {
        headline: `Air in ${s.warehouse} is too damp: ${s.value?.toFixed(0)}% relative humidity for ${dur(s.minutes)} (limit ${s.limit}%).`,
        why: `Grain takes up water from damp air. Above about 70% for long, mould can start${s.crops.some((c) => MOULD_PRONE.test(c.name)) ? ', and in maize, groundnut and sorghum mould can produce aflatoxin, which makes the grain unsellable to processors' : ''}. ${damp.length ? `${damp.join(', ')} came in at 13% moisture or more, so it has less margin. ` : ''}`,
        actions: [
          'Close doors and vents while the outside air is wetter than the inside (rain, early morning); open them in the dry heat of the afternoon.',
          'Run the fans if the store has them, and keep bags on pallets, at least 50 cm from walls.',
          'Look for roof or wall leaks and wet bags, starting with the stack nearest the sensor.',
          `Test the moisture of a few top and outside bags of ${crops}. Record the results as a stock count with a note.`,
          ...(long ? ['If any bag is above 14% moisture, tell Kitovu today so the stock can be dried or sold before it spoils.'] : []),
        ],
        urgency: urgent ? 'urgent' : 'warn',
        for_lenders: `${lend}The warehouse team has been told what to do. No action is needed from you unless Kitovu reports wet or mouldy bags.`,
      };
    }
    case 'high_temperature': {
      const over = (s.value ?? s.limit) - s.limit;
      return {
        headline: `${s.warehouse} is too warm: ${s.value?.toFixed(1)}°C for ${dur(s.minutes)} (limit ${s.limit}°C).`,
        why: `Weevils and other storage insects breed much faster in warm grain, and a store that stays hot can mean a hot spot inside a stack, where insects or mould are already working. ${total ? `There is ${kg(total)} of ${crops} here.` : ''}`,
        actions: [
          'Ventilate at night and in the early morning, when the outside air is cooler; keep the store shut in the heat of the day.',
          'Push a probe or your hand into the middle of the stacks. A stack warmer inside than the air around it has a hot spot: report it to Kitovu at once.',
          'Check a few bags for live insects, webbing and dust. Fumigation is done only by a licensed operator, arranged through Kitovu.',
          ...(over >= 5 ? ['Check the roof and walls for heat sources and make sure nothing is burning or smouldering near the store.'] : []),
        ],
        urgency: over >= 5 || s.minutes >= 24 * 60 ? 'urgent' : 'warn',
        for_lenders: `${lend}Warm stores lose quality before they lose weight. Kitovu will tell you if a count or quality test shows damage.`,
      };
    }
    case 'door_open':
      return {
        headline: `A door at ${s.warehouse} has been open for ${dur(s.minutes)}${s.device ? ` (${s.device})` : ''}.`,
        why: s.release_ordered ? 'A release is ordered at this warehouse, so this may be loading. Stock should leave only against that release order, weighed and recorded.'
          : 'No release is ordered at this warehouse, so nothing should be leaving. An open door can also let in rain, pests and theft.',
        actions: [
          'Call the warehouse manager and ask who is inside and why.',
          s.release_ordered ? 'Check that what is being loaded matches the release order and is weighed on the scale.' : 'If anything was moved, record it. If no one can explain the opening, Kitovu orders a stock count today.',
          'Close and lock the door, and confirm the sensor shows it closed.',
        ],
        urgency: s.release_ordered && s.minutes < 240 ? 'warn' : 'urgent',
        for_lenders: `${lend}${s.release_ordered ? 'A release is on order here, which may explain it.' : 'No release is on order here. Kitovu is checking with the warehouse and will count the stock if the opening is not explained.'}`,
      };
    case 'offline':
      return {
        headline: `WareGuard at ${s.warehouse}${s.device ? ` (${s.device})` : ''} has sent nothing for ${dur(s.minutes)}.`,
        why: 'Without readings no one can see the conditions in the store. Usually it is power or network, but a device can also be switched off or moved.',
        actions: [
          'Ask the warehouse manager to check the device has power and its light is on.',
          'Until it is back, take temperature and humidity readings by hand twice a day and note them on the stock count.',
          ...(s.minutes >= 24 * 60 ? ['After a day without readings, Kitovu does a stock count at this warehouse.'] : []),
        ],
        urgency: s.minutes >= 24 * 60 ? 'urgent' : 'warn',
        for_lenders: `${lend}Your stock is still recorded and insured as before; only the live readings are missing.`,
      };
  }
}

const SYSTEM = `You rewrite a warehouse alert for the people who must act on it in a Nigerian grain store. You are given a fixed headline, reason and list of actions.
Write one short paragraph (2–3 sentences) in plain English that a warehouse manager reading on a phone understands at once. Keep every number exactly as given. Do not add actions, do not change the urgency, do not speculate.`;

/** Playbook advice, with an AI summary on top when it is switched on. Never fails. */
export async function explain(s: Situation, call: ModelCall | null = defaultModel()): Promise<Advice> {
  const a = playbook(s);
  const st = await getSettings();
  if (!call || st['loans.ai_note'] === 'off' || config.kycAiMode === 'off') return a;
  try {
    const r = await call(SYSTEM, [{ type: 'text', text: `${a.headline}\n${a.why}\nActions:\n${a.actions.map((x, i) => `${i + 1}. ${x}`).join('\n')}` }]);
    return { ...a, note: r.text.trim().slice(0, 600) };
  } catch { return a; }
}
