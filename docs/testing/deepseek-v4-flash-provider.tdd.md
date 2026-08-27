# Bằng chứng TDD cho provider DeepSeek V4 Flash

## Hành trình người dùng

Người vận hành cần xác nhận `deepseek-v4-flash` có thể tạo summary tiếng Việt, grounded answer và support qua provider router mà không làm lộ credential hoặc gửi dữ liệu thật.

## RED

Command:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js
```

Kết quả: FAIL. Vitest nạp đúng test mới và dừng vì `scripts/deepseek-v4-flash-smoke.js` chưa tồn tại.

## GREEN

Command:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js
```

Kết quả: PASS, 9 tests cho adapter smoke file trước Q&A policy cutover.

Các test RED/GREEN của cutover cũng bao phủ `server/bootstrap/qa.js` và privacy admission boundary.

Command GREEN:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/qa/grounded-answer.test.js test/unit/qa/bootstrap.test.js
```

Kết quả: PASS, 29 tests.

Command coverage có phạm vi:

```text
npm test -- --run test/unit/ai/deepseek-v4-flash-provider.test.js test/unit/ai/provider-adapters.test.js test/unit/ai/provider-router.test.js test/unit/ai/provider-registry-config.test.js test/unit/ai/gemini-provider-adapter.test.js test/unit/ai/gemini-llm-smoke.test.js test/unit/qa/bootstrap.test.js test/unit/qa/grounded-answer.test.js test/unit/qa/service.test.js test/config/runtime.test.js --coverage --coverage.include=scripts/deepseek-v4-flash-smoke.js --coverage.include=server/ai/provider-registry.js --coverage.include=server/ai/provider-adapters.js --coverage.include=server/ai/provider-endpoint-profiles.js --coverage.include=server/bootstrap/qa.js --coverage.include=server/domain/qa/privacy.js --coverage.include=server/ai/provider-router.js
```

Kết quả: PASS, 141 tests. Statements 86.27%, branches 84.41%, functions 93.20%, lines 96.18%.

## Đặc tả kiểm thử

| Bảo đảm                                                                                                     | Loại kiểm thử | Kết quả |
| ----------------------------------------------------------------------------------------------------------- | ------------- | ------- |
| Endpoint chỉ tới `https://api.deepseek.com/chat/completions` và không theo redirect                         | Unit          | PASS    |
| Adapter dùng Bearer credential, JSON output và `thinking.type=disabled`                                     | Unit          | PASS    |
| Summary, answer và support đều yêu cầu model `deepseek-v4-flash`                                            | Unit          | PASS    |
| Summary chạy qua provider router với capability `nonconfidential`                                           | Integration   | PASS    |
| Q&A generation và support chạy qua provider router với capability `nonconfidential` đã được owner phê duyệt | Integration   | PASS    |
| Grounded answer thiếu citation bị từ chối                                                                   | Unit          | PASS    |
| Credential thiếu làm smoke dừng trước network dispatch                                                      | Unit          | PASS    |
| HTTP 429 được phân loại retryable mà không đọc provider error body                                          | Unit          | PASS    |
| Response bị từ chối nếu `payload.model` khác `deepseek-v4-flash`                                            | Unit          | PASS    |

## Live smoke

Command:

```text
npm run smoke:deepseek:v4-flash -- full
```

Kết quả: PASS. Ba outbound request hoàn tất qua provider router cho summary, answer và support. Mỗi response xác nhận `providerId=deepseek`, `model=deepseek-v4-flash`, `externalAttempts=1`, `fallback=none`; answer/support có `policyEligible=true`. Command xóa biến process rỗng trước khi Node nạp credential từ `.env`; test không đọc hoặc in secret.

Model catalog được kiểm tra bằng một command riêng, không phải command chat smoke:

```text
node --env-file-if-exists=.env --input-type=module -e "const key=process.env.DEEPSEEK_API_KEY;if(!key){console.log(JSON.stringify({ok:false,code:'credential_unavailable'}));process.exit(2)}const response=await fetch('https://api.deepseek.com/models',{headers:{Authorization:'Bearer '+key,Accept:'application/json'}});let data=null;try{data=await response.json()}catch{};const ids=Array.isArray(data?.data)?data.data.map((item)=>item?.id).filter((id)=>typeof id==='string'):[];console.log(JSON.stringify({ok:response.ok,status:response.status,models:ids}));"
```

Kết quả: PASS, HTTP 200. Catalog liệt kê `deepseek-v4-flash`, `deepseek-v4-pro` và `deepseek-v4-flash-vision-exp`; không có model ID mang hậu tố `0731`.

Credential được nạp bằng `node --env-file-if-exists=.env`. Test không đọc hoặc in `.env`. Smoke chỉ dùng input tổng hợp và không gửi dữ liệu MongoDB.

## Giới hạn tốc độ và privacy boundary

Tài liệu DeepSeek hiện công bố concurrency limit 2500 cho `deepseek-v4-flash` ở cấp account. Vượt giới hạn trả HTTP 429. Tài liệu không công bố RPM, RPH hoặc RPD như Gemini.

DeepSeek không công bố Zero Data Retention cho API. Cutover này khai báo Q&A là `nonconfidential` theo owner approval. Sensitive-input detector, source-policy fence, citation validation và support validation vẫn chạy trước khi persist kết quả. Không gửi dữ liệu confidential qua route này nếu chưa có evidence `zdr-verified`.

Query embedding được gọi sau privacy admission khi embedding route có capability bằng hoặc mạnh hơn Q&A workload. Route OpenRouter/BGE-M3 hiện là `nonconfidential`, tương thích với current Q&A `nonconfidential`, nên raw admitted question có thể được gửi tới embedding provider để semantic retrieval; sensitive-input vẫn chặn trước provider call, còn unavailable/incompatible thì fallback về lexical + taxonomy. Article embedding vẫn dùng BGE-M3 với compatibility identity cũ.
