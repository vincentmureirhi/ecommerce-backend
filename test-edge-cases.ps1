$TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBlY29tbWVyY2UuY29tIiwicm9sZSI6ImFkbWluIiwiZmlyc3RfbmFtZSI6IkFkbWluIiwiaWF0IjoxNzcxNjk3MTM3LCJleHAiOjE3NzQyODkxMzd9.In_QIhIOLql07inK8N6_WzzA8C_Is5E_1n75fPb4TW0"

$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $TOKEN"
}

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "EDGE CASE TESTING - MIXED RULES" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host ""

# EDGE CASE 1: Multiple items from different categories
Write-Host "EDGE CASE 1: Mixed categories in one order" -ForegroundColor Yellow
Write-Host "Buy: 1 Laptop (Cat 1, Retail) + 5 USB Cables (Cat 1, Combo) + 1 Suit (Cat 2, Manual)" -ForegroundColor Gray
Write-Host ""

$order1 = @{
    order_type = "normal"
    customer_name = "Mixed Test Customer"
    customer_phone = "0700000010"
    items = @(
        @{ product_id = 1; quantity = 1 },
        @{ product_id = 4; quantity = 5 },
        @{ product_id = 3; quantity = 1; manual_unit_price = 80000 }
    )
} | ConvertTo-Json

try {
    $resp1 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders/admin" -Method POST -Headers $headers -Body $order1 -ErrorAction Stop
    $data1 = ($resp1.Content | ConvertFrom-Json).data
    Write-Host "✅ PASSED" -ForegroundColor Green
    Write-Host "   Order Total: $($data1.total_amount)kes" -ForegroundColor Green
    Write-Host "   Expected: 50000 + 350 + 80000 = 130350kes" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "❌ FAILED: $($_.ErrorDetails.Message)" -ForegroundColor Red
    Write-Host ""
}

# EDGE CASE 2: Wholesale + Tier pricing in same order
Write-Host "EDGE CASE 2: Wholesale pricing + Tier pricing" -ForegroundColor Yellow
Write-Host "Buy: 3 Laptops (Wholesale=45000 each) + 100 Braids (Tier 3=60 each)" -ForegroundColor Gray
Write-Host ""

$order2 = @{
    order_type = "normal"
    customer_name = "Bulk Buyer"
    customer_phone = "0700000011"
    items = @(
        @{ product_id = 1; quantity = 3 },
        @{ product_id = 2; quantity = 100 }
    )
} | ConvertTo-Json

try {
    $resp2 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order2 -ErrorAction Stop
    $data2 = ($resp2.Content | ConvertFrom-Json).data
    Write-Host "✅ PASSED" -ForegroundColor Green
    Write-Host "   Order Total: $($data2.total_amount)kes" -ForegroundColor Green
    Write-Host "   Expected: (3 × 45000) + (100 × 60) = 135000 + 6000 = 141000kes" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "❌ FAILED: $($_.ErrorDetails.Message)" -ForegroundColor Red
    Write-Host ""
}

# EDGE CASE 3: Category combo exactly at threshold
Write-Host "EDGE CASE 3: Exactly at combo threshold (5 items)" -ForegroundColor Yellow
Write-Host "Buy: 5 USB Cables (Cat 1, combo threshold=5, combo price=350)" -ForegroundColor Gray
Write-Host ""

$order3 = @{
    order_type = "normal"
    customer_name = "Threshold Tester"
    customer_phone = "0700000012"
    items = @(
        @{ product_id = 4; quantity = 5 }
    )
} | ConvertTo-Json

try {
    $resp3 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order3 -ErrorAction Stop
    $data3 = ($resp3.Content | ConvertFrom-Json).data
    Write-Host "✅ PASSED" -ForegroundColor Green
    Write-Host "   Order Total: $($data3.total_amount)kes" -ForegroundColor Green
    Write-Host "   Expected: 350kes (combo applied at threshold)" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "❌ FAILED: $($_.ErrorDetails.Message)" -ForegroundColor Red
    Write-Host ""
}

# EDGE CASE 4: Just below combo threshold
Write-Host "EDGE CASE 4: BELOW threshold (4 items, need 5)" -ForegroundColor Yellow
Write-Host "Buy: 4 USB Cables (retail=500 each, NO combo)" -ForegroundColor Gray
Write-Host ""

$order4 = @{
    order_type = "normal"
    customer_name = "Below Threshold"
    customer_phone = "0700000013"
    items = @(
        @{ product_id = 4; quantity = 4 }
    )
} | ConvertTo-Json

try {
    $resp4 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order4 -ErrorAction Stop
    $data4 = ($resp4.Content | ConvertFrom-Json).data
    Write-Host "✅ PASSED" -ForegroundColor Green
    Write-Host "   Order Total: $($data4.total_amount)kes" -ForegroundColor Green
    Write-Host "   Expected: 4 × 500 = 2000kes (NO combo)" -ForegroundColor Green
    Write-Host ""
} catch {
    Write-Host "❌ FAILED: $($_.ErrorDetails.Message)" -ForegroundColor Red
    Write-Host ""
}

# EDGE CASE 5: Error handling - manual product without manual price
Write-Host "EDGE CASE 5: Manual product without manual price (SHOULD FAIL)" -ForegroundColor Yellow
Write-Host ""

$order5 = @{
    order_type = "normal"
    customer_name = "Error Test"
    customer_phone = "0700000014"
    items = @(
        @{ product_id = 3; quantity = 1 }
    )
} | ConvertTo-Json

try {
    $resp5 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order5 -ErrorAction Stop
    Write-Host "❌ FAILED - Should have rejected manual product" -ForegroundColor Red
    Write-Host ""
} catch {
    Write-Host "✅ PASSED - Correctly rejected" -ForegroundColor Green
    $errorResp = $_.ErrorDetails.Message | ConvertFrom-Json
    Write-Host "   Error: $($errorResp.error)" -ForegroundColor Green
    Write-Host ""
}

# EDGE CASE 6: Non-existent product
Write-Host "EDGE CASE 6: Non-existent product (SHOULD FAIL)" -ForegroundColor Yellow
Write-Host ""

$order6 = @{
    order_type = "normal"
    customer_name = "Not Found Test"
    customer_phone = "0700000015"
    items = @(
        @{ product_id = 99999; quantity = 1 }
    )
} | ConvertTo-Json

try {
    $resp6 = Invoke-WebRequest -Uri "http://localhost:5000/api/orders" -Method POST -Headers $headers -Body $order6 -ErrorAction Stop
    Write-Host "❌ FAILED - Should have rejected non-existent product" -ForegroundColor Red
    Write-Host ""
} catch {
    Write-Host "✅ PASSED - Correctly rejected" -ForegroundColor Green
    $errorResp = $_.ErrorDetails.Message | ConvertFrom-Json
    Write-Host "   Error: $($errorResp.error)" -ForegroundColor Green
    Write-Host ""
}

Write-Host "=====================================================" -ForegroundColor Cyan
Write-Host "EDGE CASE TESTING COMPLETE" -ForegroundColor Cyan
Write-Host "=====================================================" -ForegroundColor Cyan
