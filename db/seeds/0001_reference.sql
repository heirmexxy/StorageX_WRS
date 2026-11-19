-- Reference data: states (ISO 3166-2:NG), the Kitovu organisation and the commodity list.
-- LGAs are loaded from an official list in a later seed; imports may add the few they reference.


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
INSERT INTO commodities (code, name, category, unit, storable, max_moisture_pct, max_storage_months) VALUES
('MAZ','Maize','grain','kg',true,13.0,6),
('RCE','Paddy rice','grain','kg',true,13.0,6),
('SGM','Sorghum (guinea corn)','grain','kg',true,13.0,6),
('MLT','Millet','grain','kg',true,13.0,6),
('WHT','Wheat','grain','kg',true,13.0,6),
('SBN','Soybean','legume','kg',true,13.0,6),
('BNS','Beans (cowpea)','legume','kg',true,13.0,6),
('BBN','Bambara nut','legume','kg',true,13.0,6),
('SES','Sesame (beniseed)','oilseed','kg',true,NULL,6),
('CCA','Cocoa','tree_crop','kg',true,NULL,6),
('PML','Palm oil','oil','l',true,NULL,6),
('YAM','Yam','tuber','kg',false,NULL,3),
('IPS','Irish potato','tuber','kg',false,NULL,3),
('SPS','Sweet potato','tuber','kg',false,NULL,3),
('TMS','Tomato','vegetable','kg',false,NULL,1),
('PPR','Pepper','vegetable','kg',false,NULL,1),
('ONS','Onion','vegetable','kg',false,NULL,1)
ON CONFLICT (code) DO NOTHING;

