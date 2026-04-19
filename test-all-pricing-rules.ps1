$TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBlY29tbWVyY2UuY29tIiwicm9sZSI6ImFkbWluIiwiZmlyc3RfbmFtZSI6IkFkbWluIiwiaWF0IjoxNzcxNjk3MTM3LCJleHAiOjE3NzQyODkxMzd9.In_QIhIOLql07inK8N6_WzzA8C_Is5E_1n75fPb4TW0"

$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $TOKEN"
}

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "TESTING ALL 4 PRICING RULES" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# =====================================================
# RULE 1: RETAIL/WHOLESALE PRICING
# =====================================================
Write-Host "RULE 1: RETAIL/WHOLESALE PRICING" -ForegroundColor Yellow
Write-Host "Product 1 (Laptop): Retail=50000kes, Wholesale=45000kes (min 3 qty)" -ForegroundColor Gray
Write-Host ""

# Test 1A: Buy 1 laptop (should use retail: 50000kes)
Write-Host "Test 1A: Buy 1 laptop (should use RETAIL = 50000kes)" -ForegroundColor White

$order1a = @{
    order_type = "normal"
    customer_name = "John Test"
    customer_phone = "0700000001"
    items = @(
        @{ product_id = 1; quantity = 1 }
    )
} | ConvertTo-Json

$resp1a = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order1a
$data1a = ($resp1a.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data1a.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 50000kes" -ForegroundColor Green
Write-Host ""

# Test 1B: Buy 3 laptops (should use wholesale: 45000 * 3 = 135000kes)
Write-Host "Test 1B: Buy 3 laptops (should use WHOLESALE = 45000 each = 135000kes)" -ForegroundColor White

$order1b = @{
    order_type = "normal"
    customer_name = "Jane Test"
    customer_phone = "0700000002"
    items = @(
        @{ product_id = 1; quantity = 3 }
    )
} | ConvertTo-Json

$resp1b = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order1b
$data1b = ($resp1b.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data1b.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 135000kes" -ForegroundColor Green
Write-Host ""

# =====================================================
# RULE 4: QUANTITY TIER PRICING
# =====================================================
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "RULE 4: QUANTITY TIER PRICING" -ForegroundColor Cyan
Write-Host "Product 2 (Braids): 1-49=100kes, 50-99=80kes, 100+=60kes" -ForegroundColor Gray
Write-Host ""

# Test 4A: Buy 30 braids (tier 1: 30 * 100 = 3000kes)
Write-Host "Test 4A: Buy 30 braids (TIER 1: 30 * 100 = 3000kes)" -ForegroundColor White

$order4a = @{
    order_type = "normal"
    customer_name = "Alice Test"
    customer_phone = "0700000003"
    items = @(
        @{ product_id = 2; quantity = 30 }
    )
} | ConvertTo-Json

$resp4a = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order4a
$data4a = ($resp4a.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data4a.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 3000kes" -ForegroundColor Green
Write-Host ""

# Test 4B: Buy 75 braids (tier 2: 75 * 80 = 6000kes)
Write-Host "Test 4B: Buy 75 braids (TIER 2: 75 * 80 = 6000kes)" -ForegroundColor White

$order4b = @{
    order_type = "normal"
    customer_name = "Bob Test"
    customer_phone = "0700000004"
    items = @(
        @{ product_id = 2; quantity = 75 }
    )
} | ConvertTo-Json

$resp4b = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order4b
$data4b = ($resp4b.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data4b.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 6000kes" -ForegroundColor Green
Write-Host ""

# Test 4C: Buy 150 braids (tier 3: 150 * 60 = 9000kes)
Write-Host "Test 4C: Buy 150 braids (TIER 3: 150 * 60 = 9000kes)" -ForegroundColor White

$order4c = @{
    order_type = "normal"
    customer_name = "Carol Test"
    customer_phone = "0700000005"
    items = @(
        @{ product_id = 2; quantity = 150 }
    )
} | ConvertTo-Json

$resp4c = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order4c
$data4c = ($resp4c.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data4c.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 9000kes" -ForegroundColor Green
Write-Host ""

# =====================================================
# RULE 3: MANUAL PRICE PRODUCTS
# =====================================================
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "RULE 3: MANUAL PRICE PRODUCTS (ADMIN ONLY)" -ForegroundColor Cyan
Write-Host "Product 3 (Suit): Admin sets price manually" -ForegroundColor Gray
Write-Host ""

# Test 3A: Admin creates order with manual price
Write-Host "Test 3A: Buy 1 suit with manual price = 75000kes (ADMIN)" -ForegroundColor White

$order3a = @{
    order_type = "normal"
    customer_name = "David Test"
    customer_phone = "0700000006"
    items = @(
        @{ product_id = 3; quantity = 1; manual_unit_price = 75000 }
    )
} | ConvertTo-Json

$resp3a = Invoke-WebRequest -Uri "http://localhost:5000/api/orders/admin" -Method POST -Headers $headers -Body $order3a
$data3a = ($resp3a.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data3a.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 75000kes" -ForegroundColor Green
Write-Host ""

# =====================================================
# RULE 2: CATEGORY COMBO DISCOUNTS
# =====================================================
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "RULE 2: CATEGORY COMBO DISCOUNTS" -ForegroundColor Cyan
Write-Host "Category 1: Buy 5 items = 350kes total (instead of individual)" -ForegroundColor Gray
Write-Host ""

# Test 2A: Buy 5 items from category 1 (should trigger combo)
# 5 USB cables: Individual would be 5*500 = 2500kes, but combo is 350kes
Write-Host "Test 2A: Buy 5 USB cables from category 1 (COMBO: 350kes instead of 2500kes)" -ForegroundColor White

$order2a = @{
    order_type = "normal"
    customer_name = "Eve Test"
    customer_phone = "0700000007"
    items = @(
        @{ product_id = 4; quantity = 5 }
    )
} | ConvertTo-Json

$resp2a = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order2a
$data2a = ($resp2a.Content | ConvertFrom-Json).data
Write-Host "  Order Total: $($data2a.total_amount)kes" -ForegroundColor Green
Write-Host "  Expected: 350kes (COMBO APPLIED!)" -ForegroundColor Green
Write-Host ""

# =====================================================
# SUMMARY
# =====================================================
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "TEST SUMMARY" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""
Write-Host "RULE 1 (Retail/Wholesale):" -ForegroundColor Yellow
Write-Host "  Test 1A: $($data1a.total_amount)kes (Expected: 50000)" -ForegroundColor White
Write-Host "  Test 1B: $($data1b.total_amount)kes (Expected: 135000)" -ForegroundColor White
Write-Host ""
Write-Host "RULE 4 (Quantity Tiers):" -ForegroundColor Yellow
Write-Host "  Test 4A: $($data4a.total_amount)kes (Expected: 3000)" -ForegroundColor White
Write-Host "  Test 4B: $($data4b.total_amount)kes (Expected: 6000)" -ForegroundColor White
Write-Host "  Test 4C: $($data4c.total_amount)kes (Expected: 9000)" -ForegroundColor White
Write-Host ""
Write-Host "RULE 3 (Manual Price):" -ForegroundColor Yellow
Write-Host "  Test 3A: $($data3a.total_amount)kes (Expected: 75000)" -ForegroundColor White
Write-Host ""
Write-Host "RULE 2 (Category Combo):" -ForegroundColor Yellow
Write-Host "  Test 2A: $($data2a.total_amount)kes (Expected: 350)" -ForegroundColor White
Write-Host ""
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "TESTING COMPLETE!" -ForegroundColor Green
Write-Host "=====================================================" -ForegroundColor Cyan