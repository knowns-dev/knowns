---
id: doc-5b64a88381e2cb23d2433b48812ac365
title: Bug_Report
description: E2E test failures for variant selection verification
createdAt: '2026-03-16T18:27:59.107Z'
updatedAt: '2026-03-16T18:27:59.107Z'
tags:
  - bug
  - tests
  - e2e
---

# Bug Report: E2E Test Failures

## Summary

4 out of 19 E2E tests failed. The new variant selection tests (tests 17-19) all passed successfully.

## Test Results

| Status | Count |
|--------|-------|
| Passed | 15 |
| Failed | 4 |

## Failed Tests

### 1. Chat Page - shows chat page with sidebar
- **Test:** `e2e/chat.spec.ts:66:2`
- **Error:** `expect(locator).toBeVisible()` failed
- **Locator:** `getByText('AI Chat via OpenCode').first()`
- **Reason:** Element not found - text "AI Chat via OpenCode" not visible

### 2. Chat Page - shows session list area when sidebar has content
- **Test:** `e2e/chat.spec.ts:152:2`
- **Error:** `expect(locator).toBeVisible()` failed
- **Locator:** `locator('[class*="w-"]').filter({ hasText: 'AI Chat via OpenCode' }).first()`
- **Reason:** Element not found - sidebar content not visible

### 3. Chat Session API (local) - can create chat session via API
- **Test:** `e2e/chat.spec.ts:296:2`
- **Error:** `TypeError: server.createChat is not a function`
- **Reason:** API test fixture not properly configured

### 4. Chat Session API (local) - can delete chat session via API
- **Test:** `e2e/chat.spec.ts:309:2`
- **Error:** `TypeError: server.createChat is not a function`
- **Reason:** Same as #3 - API test fixture issue

## Passed Tests (Variant Selection - New Feature)

All 3 new variant selection tests passed:
- ✓ Test 17: can see variant selector when model has variants
- ✓ Test 18: can select a specific variant from the dropdown
- ✓ Test 19: variant selection persists in chat session

## Build Status

- **Build:** ✅ Passed successfully

## TypeScript Errors

There are pre-existing TypeScript errors in the codebase (not related to new variant selection features):
- ~30+ type errors across multiple files
- Errors include: type mismatches, possibly undefined values, missing modifiers

## Root Cause Analysis

1. **UI text changes:** Tests 2 and 7 are failing due to UI text changes - the sidebar may now display different text than "AI Chat via OpenCode"

2. **API fixture issue:** Tests 15 and 16 are failing because `server.createChat` is not defined in the test fixture - this is a pre-existing issue with the API test setup

## Recommendations

1. Update test selectors to match current UI text
2. Fix or skip the API tests until the test fixture is properly configured
3. The variant selection feature (tests 17-19) is working correctly

---
*Date: 2026-03-17*
