-- Partner types are broader than account types: input suppliers, transporters, inspectors, development
-- programmes, government and payment providers partner with Kitovu without needing a StorageX account at first.
ALTER TABLE partner_applications ADD COLUMN partner_type text;
UPDATE partner_applications SET partner_type = kind::text WHERE partner_type IS NULL;
ALTER TABLE partner_applications ALTER COLUMN partner_type SET NOT NULL;
ALTER TABLE partner_applications DROP CONSTRAINT partner_applications_kind_check;
ALTER TABLE partner_applications ADD CONSTRAINT partner_applications_kind_check CHECK (kind <> 'kitovu');
