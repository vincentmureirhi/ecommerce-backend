# YOUR ADMIN TOKEN
$TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBlY29tbWVyY2UuY29tIiwicm9sZSI6ImFkbWluIiwiZmlyc3RfbmFtZSI6IkFkbWluIiwiaWF0IjoxNzcxNjk3MTM3LCJleHAiOjE3NzQyODkxMzd9.In_QIhIOLql07inK8N6_WzzA8C_Is5E_1n75fPb4TW0"

$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $TOKEN"
}

Write-Host "CREATING 4 TEST PRODUCTS" -ForegroundColor Green
Write-Host ""

# PRODUCT 1: LAPTOP (Retail/Wholesale)
$product1 = @{
    name = "Laptop Computer"
    sku = "LAP-TEST-001"
    category_id = 1
    department_id = 1
    current_stock = 50
    cost_price = 40000
    retail_price = 50000
    wholesale_price = 45000
    min_qty_wholesale = 3
    requires_manual_price = $false
} | ConvertTo-Json

$resp1 = Invoke-WebRequest -Uri "http://localhost:5000/api/products" -Method POST -Headers $headers -Body $product1
$prod1 = ($resp1.Content | ConvertFrom-Json).data
Write-Host "PRODUCT 1: ID=$($prod1.id) - Laptop Computer (Retail/Wholesale)" -ForegroundColor Green
Write-Host ""

# PRODUCT 2: BRAIDS (Quantity Tiers)
$product2 = @{
    name = "Braids Hair"
    sku = "BRD-TEST-001"
    category_id = 1
    department_id = 2
    current_stock = 500
    cost_price = 30
    retail_price = 100
    requires_manual_price = $false
} | ConvertTo-Json

$resp2 = Invoke-WebRequest -Uri "http://localhost:5000/api/products" -Method POST -Headers $headers -Body $product2
$prod2 = ($resp2.Content | ConvertFrom-Json).data
Write-Host "PRODUCT 2: ID=$($prod2.id) - Braids Hair (Will add quantity tiers)" -ForegroundColor Green
Write-Host ""

# PRODUCT 3: SUIT (Manual Price)
$product3 = @{
    name = "Custom Tailored Suit"
    sku = "SUIT-TEST-001"
    category_id = 2
    department_id = 2
    current_stock = 10
    cost_price = 5000
    requires_manual_price = $true
} | ConvertTo-Json

$resp3 = Invoke-WebRequest -Uri "http://localhost:5000/api/products" -Method POST -Headers $headers -Body $product3
$prod3 = ($resp3.Content | ConvertFrom-Json).data
Write-Host "PRODUCT 3: ID=$($prod3.id) - Custom Tailored Suit (Manual Price)" -ForegroundColor Green
Write-Host ""

# PRODUCT 4: USB CABLE (Category Combo)
$product4 = @{
    name = "USB-C Cable"
    sku = "USB-TEST-001"
    category_id = 1
    department_id = 1
    current_stock = 100
    cost_price = 200
    retail_price = 500
    wholesale_price = 400
    min_qty_wholesale = 2
    requires_manual_price = $false
} | ConvertTo-Json

$resp4 = Invoke-WebRequest -Uri "http://localhost:5000/api/products" -Method POST -Headers $headers -Body $product4
$prod4 = ($resp4.Content | ConvertFrom-Json).data
Write-Host "PRODUCT 4: ID=$($prod4.id) - USB-C Cable (Category Combo)" -ForegroundColor Green
Write-Host ""

Write-Host "SUCCESS! All 4 products created." -ForegroundColor Cyan
Write-Host ""
Write-Host "PRODUCT IDS:" -ForegroundColor Yellow
Write-Host "  Product 1: $($prod1.id) (Laptop - Retail/Wholesale)"
Write-Host "  Product 2: $($prod2.id) (Braids - Quantity Tiers)"
Write-Host "  Product 3: $($prod3.id) (Suit - Manual Price)"
Write-Host "  Product 4: $($prod4.id) (USB Cable - Category Combo)"
Write-Host ""