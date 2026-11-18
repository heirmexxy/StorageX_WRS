-- Suggested wording for the farmer helper's answer ("what is my produce worth, what do I owe") in Pidgin,
-- Hausa, Yoruba and Igbo. They arrive as drafts: a Kitovu person who speaks the language checks each one under
-- Farmer messages and approves it before any farmer receives it. Only added if that language has no wording yet.
INSERT INTO message_templates (event, language, body)
SELECT v.event, v.language, v.body FROM (VALUES
  ('balance_reply', 'pcm', 'StorageX: your produce for store na {held}, e worth about {worth} for today price. You dey owe {owed}. Next day to pay: {due}. Price dey change; na guide be this, no be offer.'),
  ('balance_reply', 'ha',  'StorageX: kayanka a ajiya {held}, darajarsu kusan {worth} a farashin yau. Bashin da ake binka {owed}. Ranar biya ta gaba: {due}. Farashi na canzawa; wannan jagora ne, ba tayi ba.'),
  ('balance_reply', 'yo',  'StorageX: ọjà rẹ ní ilé ìpamọ́ jẹ́ {held}, iye rẹ̀ tó {worth} ní owó òní. Gbèsè tí o jẹ: {owed}. Ọjọ́ ìsanwó tó kàn: {due}. Owó ọjà máa ń yí padà; ìtọ́sọ́nà ni èyí, kì í ṣe ìfilọ̀.'),
  ('balance_reply', 'ig',  'StorageX: ihe i debere n''ụlọ nchekwa bụ {held}, ọ ruru ihe dị ka {worth} n''ọnụahịa taa. Ụgwọ i ji: {owed}. Ụbọchị ịkwụ ụgwọ ọzọ: {due}. Ọnụahịa na-agbanwe; nke a bụ ntụziaka, ọ bụghị ọnụahịa onye na-azụ kwere.')
) AS v(event, language, body)
WHERE NOT EXISTS (SELECT 1 FROM message_templates t WHERE t.event = v.event AND t.language = v.language AND t.status IN ('live','draft'));
