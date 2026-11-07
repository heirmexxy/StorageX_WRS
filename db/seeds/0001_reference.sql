-- Reference data: states (ISO 3166-2:NG), the Kitovu organisation and the commodity list.
-- LGAs are loaded from an official list in a later seed; imports may add the few they reference.

BEGIN;

INSERT INTO states (code, name) VALUES
('AB','Abia'),('AD','Adamawa'),('AK','Akwa Ibom'),('AN','Anambra'),('BA','Bauchi'),('BY','Bayelsa'),
('BE','Benue'),('BO','Borno'),('CR','Cross River'),('DE','Delta'),('EB','Ebonyi'),('ED','Edo'),
('EK','Ekiti'),('EN','Enugu'),('FC','Federal Capital Territory'),('GO','Gombe'),('IM','Imo'),('JI','Jigawa'),
('KD','Kaduna'),('KN','Kano'),('KT','Katsina'),('KE','Kebbi'),('KO','Kogi'),('KW','Kwara'),
('LA','Lagos'),('NA','Nasarawa'),('NI','Niger'),('OG','Ogun'),('ON','Ondo'),('OS','Osun'),
('OY','Oyo'),('PL','Plateau'),('RI','Rivers'),('SO','Sokoto'),('TA','Taraba'),('YO','Yobe'),('ZA','Zamfara')
ON CONFLICT (code) DO NOTHING;

INSERT INTO organisations (code, name, kind) VALUES
('KITOVU', 'Kitovu Technology Company Limited', 'kitovu')
ON CONFLICT (code) DO NOTHING;

-- Commodity codes keep the legacy three-letter codes so old receipts still read correctly.
-- max_moisture_pct 13.0 for grains and legumes follows Kitovu's StorageX process flow; others are set later.
INSERT INTO commodities (code, name, category, unit, storable, max_moisture_pct) VALUES
('MAZ','Maize','grain','kg',true,13.0),
('RCE','Paddy rice','grain','kg',true,13.0),
('SGM','Sorghum (guinea corn)','grain','kg',true,13.0),
('MLT','Millet','grain','kg',true,13.0),
('WHT','Wheat','grain','kg',true,13.0),
('SBN','Soybean','legume','kg',true,13.0),
('BNS','Beans (cowpea)','legume','kg',true,13.0),
('BBN','Bambara nut','legume','kg',true,13.0),
('SES','Sesame (beniseed)','oilseed','kg',true,NULL),
('CCA','Cocoa','tree_crop','kg',true,NULL),
('PML','Palm oil','oil','l',true,NULL),
('YAM','Yam','tuber','kg',false,NULL),
('IPS','Irish potato','tuber','kg',false,NULL),
('SPS','Sweet potato','tuber','kg',false,NULL),
('TMS','Tomato','vegetable','kg',false,NULL),
('PPR','Pepper','vegetable','kg',false,NULL),
('ONS','Onion','vegetable','kg',false,NULL)
ON CONFLICT (code) DO NOTHING;

COMMIT;
