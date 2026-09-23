-- XPOSE BEAUTY SHOP LIMITED branding update
-- Updates the existing terms record so existing databases receive the new company name.
UPDATE public.terms_conditions
SET
  content = REPLACE(
    REPLACE(content, 'XPOSE DISTRIBUTORS', 'XPOSE BEAUTY SHOP LIMITED'),
    'XPOSE Distributors',
    'XPOSE Beauty Shop Limited'
  ),
  updated_at = NOW()
WHERE content ILIKE '%XPOSE%Distributors%';
