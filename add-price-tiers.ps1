$TOKEN = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpZCI6MSwiZW1haWwiOiJhZG1pbkBlY29tbWVyY2UuY29tIiwicm9sZSI6ImFkbWluIiwiZmlyc3RfbmFtZSI6IkFkbWluIiwiaWF0IjoxNzcxNjk3MTM3LCJleHAiOjE3NzQyODkxMzd9.In_QIhIOLql07inK8N6_WzzA8C_Is5E_1n75fPb4TW0"

$headers = @{
    "Content-Type" = "application/json"
    "Authorization" = "Bearer $TOKEN"
}

Write-Host "Adding Quantity Tiers to Product 2 (Braids)" -ForegroundColor Green
Write-Host ""

# TIER 1: 1-49 units = 100kes each
$tier1 = @{
    product_id = 2
    min_qty = 1
    max_qty = 49
    unit_price = 100
} | ConvertTo-Json

$resp1 = Invoke-WebRequest -Uri "http://localhost:5000/api/price-tiers" -Method POST -Headers $headers -Body $tier1
Write-Host "TIER 1: 1-49 units = 100kes each" -ForegroundColor Cyan

# TIER 2: 50-99 units = 80kes each
$tier2 = @{
    product_id = 2
    min_qty = 50
    max_qty = 99
    unit_price = 80
} | ConvertTo-Json

$resp2 = Invoke-WebRequest -Uri "http://localhost:5000/api/price-tiers" -Method POST -Headers $headers -Body $tier2
Write-Host "TIER 2: 50-99 units = 80kes each" -ForegroundColor Cyan

# TIER 3: 100+ units = 60kes each
$tier3 = @{
    product_id = 2
    min_qty = 100
    unit_price = 60
} | ConvertTo-Json

$resp3 = Invoke-WebRequest -Uri "http://localhost:5000/api/price-tiers" -Method POST -Headers $headers -Body $tier3
Write-Host "TIER 3: 100+ units = 60kes each" -ForegroundColor Cyan

Write-Host ""
Write-Host "SUCCESS! Price tiers added." -ForegroundColor Green