# DeepSeek V4 Flash provider TDD evidence

## User journey

Người vận hành cần xác nhận `deepseek-v4-flash` có thể tạo summary tiếng Việt và thực hiện compatibility probe cho grounded answer/support mà không làm lộ credential hoặc gửi dữ liệu thật.

## RED

Command:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js
```

Result: FAIL. Vitest nạp đúng test mới và dừng vì `scripts/deepseek-v4-flash-smoke.js` chưa tồn tại.

## GREEN

Command:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js
```

Result: PASS, 9 tests.

Targeted coverage command:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/ai/provider-adapters.test.js test/unit/ai/provider-router.test.js test/unit/ai/provider-registry-config.test.js test/unit/ai/gemini-provider-adapter.test.js test/unit/ai/gemini-llm-smoke.test.js --coverage --coverage.include=scripts/deepseek-v4-flash-smoke.js --coverage.include=server/ai/provider-adapters.js --coverage.include=server/ai/provider-endpoint-profiles.js --coverage.include=server/ai/provider-router.js
```

Result: PASS, 73 tests. Statements 88.31%, branches 85.78%, functions 93.93%, lines 94.63%.

## Test specification

| Guarantee | Test type | Result |
|---|---|---|
| Endpoint chỉ tới `https://api.deepseek.com/chat/completions` và không theo redirect | Unit | PASS |
| Adapter dùng Bearer credential, JSON output và `thinking.type=disabled` | Unit | PASS |
| Summary, answer và support đều yêu cầu model `deepseek-v4-flash` | Unit | PASS |
| Summary chạy qua provider policy với capability `nonconfidential` | Integration | PASS |
| Q&A probe không khai báo ZDR và được đánh dấu `policyEligible=false` | Integration | PASS |
| Grounded answer thiếu citation bị từ chối | Unit | PASS |
| Credential thiếu làm smoke dừng trước network dispatch | Unit | PASS |
| HTTP 429 được phân loại retryable mà không đọc provider error body | Unit | PASS |
| Response bị từ chối nếu `payload.model` khác `deepseek-v4-flash` | Unit | PASS |

## Live smoke

Command:

```text
npm run smoke:deepseek:v4-flash -- full
```

Result: PASS. Ba outbound request hoàn tất: summary, answer và support. Mỗi response xác nhận `payload.model=deepseek-v4-flash`.

Model catalog được kiểm tra bằng một command riêng, không phải command chat smoke:

```text
node --env-file-if-exists=.env --input-type=module -e "const key=process.env.DEEPSEEK_API_KEY;if(!key){console.log(JSON.stringify({ok:false,code:'credential_unavailable'}));process.exit(2)}const response=await fetch('https://api.deepseek.com/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'}});let data=null;try{data=await response.json()}catch{};const ids=Array.isArray(data?.data)?data.data.map((item)=>item?.id).filter((id)=>typeof id==='string'):[];console.log(JSON.stringify({ok:response.ok,status:response.status,models:ids}));"
```

Result: PASS, HTTP 200. Catalog liệt kê `deepseek-v4-flash`, `deepseek-v4-pro` và `deepseek-v4-flash-vision-exp`; không có model ID mang hậu tố `0731`.

Credential được nạp bằng `node --env-file-if-exists=.env`. Test không đọc hoặc in `.env`. Smoke chỉ dùng input tổng hợp và không gửi dữ liệu MongoDB.

## Rate limit và privacy gap

Tài liệu DeepSeek hiện công bố concurrency limit 2500 cho `deepseek-v4-flash` ở cấp account. Vượt giới hạn trả HTTP 429. Tài liệu không công bố RPM, RPH hoặc RPD như Gemini.

DeepSeek không công bố Zero Data Retention cho API. Vì vậy provider này chưa đủ điều kiện cho Q&A production theo policy `zdr-verified` hiện tại. Compatibility probe chỉ chứng minh giao thức và output contract với dữ liệu tổng hợp.
